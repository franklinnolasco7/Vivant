<p align="center">
  <img src="src-tauri/icons/vivant.svg" width="120px" alt="Vivant logo" />
</p>

<h3 align="center">Read More. Live More. Vivant.</h3>
<p align="center">A native Tauri e-reader for Linux.</p>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-GPL%20v3-teal.svg?style=flat-square" alt="License" />
  </a>
  <a href="https://www.linux.org/pages/download/">
    <img src="https://img.shields.io/badge/Platform-Linux-FCC624?style=flat-square&logo=linux&logoColor=black" alt="Platform" />
  </a>
  <a href="https://github.com/franklinnolasco7/Vivant/releases">
    <img src="https://img.shields.io/badge/Status-Unreleased-lightgrey?style=flat-square" alt="Status" />
  </a>

</p>

---

## Requirements

| Tool      | Version          |
| --------- | ---------------- |
| Node.js   | 18+              |
| npm       | 9+               |
| Rust      | stable           |
| WebKitGTK | 6.0 dev packages |

Install system dependencies for your distro:

```bash
# Arch
sudo pacman -S rustup nodejs npm webkitgtk-6.0 base-devel

# Fedora
sudo dnf install rust cargo nodejs npm webkitgtk6.0-devel

# Debian / Ubuntu
sudo apt install rustup nodejs npm libwebkitgtk-6.0-dev

rustup toolchain install stable
rustup default stable
```

---

## Quick Start

### Option 1: Local setup

```bash
git clone https://github.com/franklinnolasco7/Vivant.git
cd Vivant
npm install
npm run tauri dev
```

### Option 2: Docker (optional)

Docker is optional and provided for contributors who prefer a consistent, containerized development environment.

```bash
git clone https://github.com/franklinnolasco7/Vivant.git
cd Vivant
./scripts/docker-shell.sh
```

For full Docker usage, see [DOCKER.md](DOCKER.md).

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before PR. Project follows strict rules (GPL-3.0, parameterized SQL, no telemetry).

---

## Scripts

| Command               | Description                           |
| --------------------- | ------------------------------------- |
| `npm run dev`         | Start the frontend dev server         |
| `npm run build`       | Build the frontend for production     |
| `npm run test`        | Run the test suite                    |
| `npm run tauri dev`   | Launch the full Tauri app in dev mode |
| `npm run tauri build` | Build a production Tauri binary       |

---

## Data

Vivant stores your library database at:

```
~/.local/share/dev.vivant.reader/vivant.db
```

---

## License

Distributed under the GPL-3.0 License. See [LICENSE](LICENSE) for more information.
