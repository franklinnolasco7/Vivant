# Docker Setup for Vellum

This Docker configuration provides a development environment with Node.js and Rust pre-installed.
Docker is optional and intended for contributors who want a consistent environment.

## Quick Start

### Using helper script (recommended)

Start and enter the development container with one command:

```bash
./scripts/docker-shell.sh
```

### Using Docker Compose directly

Start the development container:

```bash
docker compose up -d
```

Enter the container:

```bash
docker compose exec vellum-dev bash
```

Stop the container:

```bash
docker compose down
```

### Using Docker directly

Build the image:

```bash
docker build -t vellum-dev .
```

Run the container:

```bash
docker run -it -v $(pwd):/workspace vellum-dev bash
```

## Inside the Container

Once inside, you have:

**Frontend development:**

```bash
npm install
npm run dev
```

**Backend development:**

```bash
cd src-tauri
cargo build
cargo run
```

**Run tests:**

```bash
npm test             # Frontend tests
cargo test           # Rust tests
```

## Volumes

- `cargo-cache`: Persists Rust dependency cache between container runs
- `npm-cache`: Persists npm cache between container runs
- Project directory is mounted at `/workspace`

## Notes

- All changes you make to files are synced between your host machine and the container
- Dependencies are cached, so rebuilding the container is fast
- The container uses the same architecture as your host machine

## Platform Support

- Linux: supported
- macOS: supported
- Windows: supported via Docker Desktop (WSL2 backend recommended)
