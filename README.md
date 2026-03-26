<div align="center">

<img width="120" height="120" alt="vellum logo" src="https://github.com/user-attachments/assets/91b5141d-0e76-46cf-a5f0-c4ceba335bc3" />

# Vellum

*Built for readers who care.*

A native Tauri e-reader for Linux.

[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg?style=flat-square)](LICENSE)
[![Tauri](https://img.shields.io/badge/Built%20with-Tauri-24C8D8?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/Rust-stable-CE412B?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=flat-square&logo=node.js)](https://nodejs.org)

---

<img src="https://github.com/user-attachments/assets/e642b466-7cfd-4d8a-977c-59ebca0d05ad" alt="Vellum Screenshot — Library View" width="90%" />

<br/>

<img src="https://github.com/user-attachments/assets/6df63185-783f-4ddd-ac43-9b20b82f1eb8" alt="Vellum Screenshot — Reading View" width="90%" />

</div>

---

## Requirements

| Tool | Version |
|------|---------|
| Node.js | 18+ |
| npm | 9+ |
| Rust | stable |
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

```bash
git clone https://github.com/franklinnolasco7/Vellum.git
cd vellum
npm install
npm run tauri dev
```

---

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start the frontend dev server |
| `npm run build` | Build the frontend for production |
| `npm run test` | Run the test suite |
| `npm run tauri dev` | Launch the full Tauri app in dev mode |
| `npm run tauri build` | Build a production Tauri binary |

---

## Data

Vellum stores your library database at:

```
~/.local/share/dev.vellum.reader/vellum.db
```

---

⚠️ Vellum is in early development. Expect bugs and breaking changes.

---

## License

MIT — see [LICENSE](LICENSE) for details.
