    return [
        ("mingw_prefix", "MinGW prefix", mingw),
        EnumVariable("windows_subsystem", "Windows subsystem", "gui", ["gui", "console"], ignorecase=2),
        ("msvc_version", "MSVC version to use. Handled automatically by SCons if omitted.", ""),
        ("mssdk_version", "Windows SDK version to use. Handled automatically by SCons if omitted.", ""),
        BoolVariable("use_mingw", "Use the Mingw compiler, even if MSVC is installed.", False),
        BoolVariable("use_llvm", "Use the LLVM compiler", False),
        BoolVariable("use_static_cpp", "Link MinGW/MSVC C++ runtime libraries statically", True),
        BoolVariable("use_asan", "Use address sanitizer (ASAN)", False),
        BoolVariable("use_ubsan", "Use LLVM compiler undefined behavior sanitizer (UBSAN)", False),
        BoolVariable("debug_crt", "Compile with MSVC's debug CRT (/MDd)", False),
        BoolVariable("incremental_link", "Use MSVC incremental linking. May increase or decrease build times.", False),
        BoolVariable("silence_msvc", "Silence MSVC's cl/link stdout bloat, redirecting any errors to stderr.", True),
        BoolVariable("winrt", "Use WinRT API (OneCore TTS support).", True),

def get_flags():
    arch = detect_build_env_arch() or detect_arch()

    return {
        "arch": arch,
        "d3d12": True,
        "supported": ["d3d12", "dcomp", "library", "mono", "xaudio2"],
    }


