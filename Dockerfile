# Development environment for Vivant
FROM ubuntu:22.04

# Install system dependencies
RUN apt-get update && apt-get install -y \
  curl \
  wget \
  git \
  build-essential \
  pkg-config \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libwebkit2gtk-4.1-dev \
  && rm -rf /var/lib/apt/lists/*

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user for development work
RUN useradd -ms /bin/bash developer

USER developer
WORKDIR /home/developer

# Install Rust for the non-root user
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
  && /home/developer/.cargo/bin/rustup default stable

# Set environment variables for Rust
ENV PATH="/home/developer/.cargo/bin:${PATH}"

# Set working directory
WORKDIR /workspace

# Install frontend dependencies (optional, can skip if you prefer)
# COPY package.json package-lock.json ./
# RUN npm install

# Default command
CMD ["/bin/bash"]
