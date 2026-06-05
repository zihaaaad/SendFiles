@echo off
title SendFiles P2P Launcher
echo ==================================================
echo Starting SendFiles P2P Setup...
echo ==================================================

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/ before running this application.
    pause
    exit /b 1
)

:: Check if node_modules folder exists
if not exist node_modules (
    echo node_modules folder not found. Installing dependencies...
    call npm install
    if %errorlevel% neq 0 (
        echo Error: npm install failed!
        pause
        exit /b 1
    )
) else (
    echo Dependencies already installed. Skipping npm install...
)

echo Starting development server...
call npm run dev
pause
