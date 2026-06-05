#!/bin/bash

echo "=================================================="
echo "Starting SendFiles P2P Setup..."
echo "=================================================="

# Check if Node.js is installed
if ! command -v node &> /dev/null
then
    echo "Error: Node.js is not installed!"
    echo "Please install Node.js before running this application."
    exit 1
fi

# Check if node_modules folder exists
if [ ! -d "node_modules" ]; then
    echo "node_modules folder not found. Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "Error: npm install failed!"
        exit 1
    fi
else
    echo "Dependencies already installed. Skipping npm install..."
fi

echo "Starting development server..."
npm run dev
