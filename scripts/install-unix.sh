#!/usr/bin/env sh
set -eu

# Installs BunClaw from GitHub Releases on Linux/macOS and ensures PATH for user-level install.
REPO="${BUNCLAW_REPO:-idao-cube/bunclaw}"
VERSION="${1:-latest}"
PREFERRED_INSTALL_DIR="${BUNCLAW_INSTALL_DIR:-/usr/local/bin}"

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

detect_os() {
  case "$(lower "$(uname -s)")" in
    linux*)
      printf 'linux'
      ;;
    darwin*)
      printf 'darwin'
      ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      exit 1
      ;;
  esac
}

detect_arch() {
  case "$(lower "$(uname -m)")" in
    x86_64|amd64)
      printf 'x64'
      ;;
    aarch64|arm64)
      printf 'arm64'
      ;;
    *)
      echo "Unsupported architecture: $(uname -m)" >&2
      exit 1
      ;;
  esac
}

download() {
  url="$1"
  out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
    return
  fi
  echo "curl or wget is required" >&2
  exit 1
}

ensure_user_path() {
  user_bin="$HOME/.local/bin"
  case ":$PATH:" in
    *":$user_bin:"*)
      return
      ;;
  esac

  shell_name="$(basename "${SHELL:-sh}")"
  rc_file="$HOME/.profile"
  if [ "$shell_name" = "zsh" ]; then
    rc_file="$HOME/.zshrc"
  elif [ "$shell_name" = "bash" ]; then
    rc_file="$HOME/.bashrc"
  fi

  path_line='export PATH="$HOME/.local/bin:$PATH"'
  if [ ! -f "$rc_file" ] || ! grep -F "$path_line" "$rc_file" >/dev/null 2>&1; then
    printf '\n%s\n' "$path_line" >> "$rc_file"
    echo "Added ~/.local/bin to PATH in $rc_file"
    echo "Run: source $rc_file"
  fi
}

OS="$(detect_os)"
ARCH="$(detect_arch)"
ASSET_NAME="bunclaw-bun-${OS}-${ARCH}"

if [ "$VERSION" = "latest" ]; then
  ASSET_URL="https://github.com/${REPO}/releases/latest/download/${ASSET_NAME}"
else
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *) TAG="v$VERSION" ;;
  esac
  ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET_NAME}"
fi

INSTALL_DIR="$PREFERRED_INSTALL_DIR"
if [ ! -d "$INSTALL_DIR" ]; then
  mkdir -p "$INSTALL_DIR" 2>/dev/null || true
fi

if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t bunclaw-install)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
TMP_BIN="$TMP_DIR/bunclaw"

echo "Downloading $ASSET_NAME"
download "$ASSET_URL" "$TMP_BIN"
chmod +x "$TMP_BIN"

DEST="$INSTALL_DIR/bunclaw"
if command -v install >/dev/null 2>&1; then
  install -m 0755 "$TMP_BIN" "$DEST"
else
  cp "$TMP_BIN" "$DEST"
  chmod 0755 "$DEST"
fi

if [ "$INSTALL_DIR" = "$HOME/.local/bin" ]; then
  ensure_user_path
fi

echo "Installed: $DEST"
echo "Check: bunclaw --help"
