#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Define Node.js version to install
# Node.js 20 is the current LTS. You can change to 18 if needed, but 20 is recommended.
NODE_MAJOR=20

# Check if script is run as root
if [ "$EUID" -ne 0 ]; then
    echo "Please run this script as root or with sudo."
    exit 1
fi

echo "------------------------------------------------------"
echo "  Starting Node.js Project Installation on Armbian  "
echo "------------------------------------------------------"
echo ""

# Step 1: Update and upgrade system packages
echo "Updating and upgrading system packages..."
apt update -y
apt upgrade -y
apt autoremove -y
echo "System packages updated."
echo ""

# Step 2: Install Node.js and npm (using NodeSource PPA for latest LTS)
echo "Installing Node.js (v${NODE_MAJOR}) and npm..."

# Check if Node.js is already installed and remove old versions to ensure a clean install
if command -v node &>/dev/null; then
    echo "Node.js already detected. Attempting to remove existing installation to ensure a clean install."
    apt purge nodejs -y || true # Use || true to prevent script from exiting if package not found
    rm -rf /etc/apt/sources.list.d/nodesource.list || true # Remove old NodeSource entry
    apt autoremove -y
    apt clean
    echo "Existing Node.js removed (if present)."
fi

# Add NodeSource PPA for the specified Node.js version
echo "Adding NodeSource PPA for Node.js v${NODE_MAJOR}..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash -
echo "Installing Node.js and npm from NodeSource PPA..."
apt install -y nodejs
echo "Node.js and npm installed."
echo ""

# Step 3: Install PM2 globally
echo "Installing PM2 globally..."
npm install -g pm2
echo "PM2 installed."
echo ""

# Step 4: Install SQLite3 tools (system package)
echo "Installing SQLite3 command-line tools..."
apt install -y sqlite3
echo "SQLite3 tools installed."
echo ""

# Step 5: Navigate to project directory and install Node.js dependencies
# This assumes the script is run from the root of the project directory
PROJECT_DIR="$(dirname "$(realpath "$0")")"
echo "Navigating to project directory: $PROJECT_DIR"
cd "$PROJECT_DIR"
echo "Installing Node.js project dependencies (npm install)..."
npm install
echo "Node.js project dependencies installed."
echo ""

# Step 6: Configure and start application with PM2
echo "Configuring and starting application with PM2..."

# Stop and delete any existing PM2 process named 'node-app' or all to ensure a clean start
echo "Stopping and deleting existing PM2 processes..."
pm2 delete node-app || true # Delete specific app if exists, ignore errors if not running
pm2 stop all || true       # Stop all running apps, ignore errors
pm2 delete all || true     # Delete all apps, ignore errors
echo "Existing PM2 processes cleared."

# Start the application using PM2
echo "Starting 'server.js' with PM2 under the name 'node-app'..."
pm2 start server.js --name "node-app"
echo "Application 'node-app' started."

# Configure PM2 to start on boot
echo "Configuring PM2 to start automatically on system boot..."
pm2 startup systemd
pm2 save
echo "PM2 autostart configured and saved."
echo ""

# Step 7: Final checks and instructions
echo "------------------------------------------------------"
echo "  Installation Complete!                              "
echo "------------------------------------------------------"
echo "You can check the application status using: pm2 status"
echo "View application logs with: pm2 logs node-app"
echo "The application is configured to start automatically on boot."
echo "Access the application via your browser on port 3000 (or as configured in server.js)."
echo ""
echo "IMPORTANT NOTES:"
echo "1. Ensure your firewall (if any) allows traffic on the configured port (default 3000)."
echo "2. For Baileys WA Gateway, remember to scan the QR code for the first session:"
echo "   - The QR code will appear in the server console/pm2 logs when Baileys initializes."
echo "   - You might need to run 'pm2 restart node-app' and then check 'pm2 logs node-app' to see the QR code."
echo "3. SQLite database 'mydb.sqlite' will be created in the project directory if it doesn't exist."
echo ""
echo "Enjoy your Node.js application!"