import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[2]


def verify(vsix: Path) -> None:
    expected = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    # vsce normalizes documentation filenames when packaging.
    required = {
        "[Content_Types].xml",
        "extension.vsixmanifest",
        "extension/package.json",
        "extension/readme.md",
        "extension/changelog.md",
        "extension/LICENSE.txt",
        f"extension/{expected['main'].removeprefix('./')}",
        f"extension/{expected['icon']}",
        "extension/media/main.js",
        "extension/media/style.css",
    }
    required.update(
        f"extension/{container['icon']}"
        for container in expected["contributes"]["viewsContainers"]["activitybar"]
    )

    with zipfile.ZipFile(vsix) as archive:
        corrupt = archive.testzip()
        if corrupt:
            raise ValueError(f"Corrupt VSIX entry: {corrupt}")
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("VSIX contains duplicate entries.")
        missing = required - set(names)
        if missing:
            raise ValueError(f"VSIX is missing required files: {', '.join(sorted(missing))}")
        for name in required:
            if archive.getinfo(name).file_size == 0:
                raise ValueError(f"VSIX contains an empty required file: {name}")
        for name in names:
            if name.startswith((
                "extension/.github/",
                "extension/.git/",
                "extension/.vscode/",
                "extension/src/",
                "extension/test/",
                "extension/node_modules/",
            )) or name.endswith(".map"):
                raise ValueError(f"VSIX includes a development file: {name}")

        packaged = json.loads(archive.read("extension/package.json"))
        for field in ("name", "publisher", "version", "main", "engines"):
            if packaged[field] != expected[field]:
                raise ValueError(f"Packaged extension metadata differs: {field}")
        identity = ET.fromstring(archive.read("extension.vsixmanifest")).find(".//{*}Identity")
        if identity is None:
            raise ValueError("VSIX manifest has no extension identity.")
        for attribute, field in (("Id", "name"), ("Publisher", "publisher"), ("Version", "version")):
            if identity.get(attribute) != expected[field]:
                raise ValueError(f"VSIX manifest identity differs: {attribute}")

    print(f"Verified {vsix}: required files, metadata, and packaging exclusions are valid.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Validate the generated extension package.")
    parser.add_argument("vsix", type=Path)
    verify(parser.parse_args().vsix)
