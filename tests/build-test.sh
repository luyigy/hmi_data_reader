#!/bin/bash

echo "--- Starting Agent Platform v2 Build Test ---"

PROJECT_DIR="E:/projects/agent-platform-v2"

# Navigate to the project directory
cd "$PROJECT_DIR"

# Clean node_modules and reinstall dependencies
echo "Cleaning node_modules and reinstalling dependencies..."
rm -rf node_modules
npm cache clean --force
npm install

if [ $? -ne 0 ]; then
  echo "Error: npm install failed."
  exit 1
fi

echo "Dependencies installed successfully."

# Run the build command
echo "Running project build..."
npm run build

if [ $? -ne 0 ]; then
  echo "Error: Project build failed."
  exit 1
fi

echo "--- Agent Platform v2 Build Test Completed Successfully ---"
exit 0
