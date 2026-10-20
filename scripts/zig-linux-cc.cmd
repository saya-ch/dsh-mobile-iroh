@echo off
"%~dp0..\artifacts\toolchains\zig-0.15.2\zig-x86_64-windows-0.15.2\zig.exe" cc -target x86_64-linux-musl %*
