@echo off
REM Run Sui from this checkout on Windows CMD. No npm, no publish, no npx.
REM   sui doctor
REM   sui start
node "%~dp0apps\cli\bin\sui.js" %*
