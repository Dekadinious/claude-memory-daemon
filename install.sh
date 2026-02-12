#!/bin/bash
# Quick install: sets up systemd user service for claude-memory-daemon

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing claude-memory-daemon..."

# Install dependencies
cd "$SCRIPT_DIR"
npm install

# Create global link
npm link

# Set up systemd service
claude-memory install-service

echo ""
echo "Installation complete!"
echo "  - 'claude-memory' command is now available globally"
echo "  - Daemon will auto-start on login"
echo ""
echo "Next: cd into a project and run 'claude-memory init'"
