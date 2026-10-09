#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.request


def main():
    parser = argparse.ArgumentParser(description='Explicit CI download of the official latest native Linux x64 Claude artifact')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--version')
    args = parser.parse_args()
    base = 'https://downloads.claude.ai/claude-code-releases'
    version = args.version
    if version is None:
        with urllib.request.urlopen(base + '/latest', timeout=30) as response:
            version = response.read(128).decode('ascii').strip()
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
        raise RuntimeError('Official latest channel did not resolve to a release version')
    with urllib.request.urlopen(base + '/' + version + '/manifest.json', timeout=30) as response:
        manifest = json.loads(response.read(65536))
    artifact = manifest['platforms']['linux-x64']
    if manifest.get('version') != version or artifact.get('binary') != 'claude' or not re.fullmatch(r'[a-f0-9]{64}', artifact['checksum']):
        raise RuntimeError('Official release manifest is invalid')
    args.output.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=args.output.name + '.', suffix='.download', dir=args.output.parent)
    temporary = Path(name)
    try:
        digest = hashlib.sha256()
        size = 0
        with os.fdopen(descriptor, 'wb') as output, urllib.request.urlopen(base + '/' + version + '/linux-x64/claude', timeout=60) as response:
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > artifact['size']:
                    raise RuntimeError('Official native artifact exceeds its declared size')
                digest.update(block)
                output.write(block)
        if size != artifact['size'] or digest.hexdigest() != artifact['checksum']:
            raise RuntimeError('Official native artifact checksum or size mismatch')
        with temporary.open('rb') as source:
            header = source.read(20)
        if header[:6] != b'\x7fELF\x02\x01' or header[18:20] != b'\x3e\x00':
            raise RuntimeError('Official artifact is not native Linux x64')
        os.chmod(temporary, 0o700)
        temporary.replace(args.output)
        print('Official native Claude ' + version + ': manifest SHA256, size and Linux x64 ELF verified')
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
