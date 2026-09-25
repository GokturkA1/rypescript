// bridge.cpp
#include "lld/Common/Driver.h"
#include "llvm/Support/raw_ostream.h"
#include <vector>

// 1. ADIM: Sistemdeki LLD makrolarının arkasında kalan tüm gizli mimari 
// linkleme fonksiyonlarını derleyiciye tek tek bildiriyoruz (Forward Declaration)
namespace lld {
    namespace elf {
        bool link(llvm::ArrayRef<const char *> args, llvm::raw_ostream &stdoutOS, llvm::raw_ostream &stderrOS, bool exitEarly, bool disableOutput);
    }
    namespace coff {
        bool link(llvm::ArrayRef<const char *> args, llvm::raw_ostream &stdoutOS, llvm::raw_ostream &stderrOS, bool exitEarly, bool disableOutput);
    }
    namespace macho {
        bool link(llvm::ArrayRef<const char *> args, llvm::raw_ostream &stdoutOS, llvm::raw_ostream &stderrOS, bool exitEarly, bool disableOutput);
    }
    namespace wasm {
        bool link(llvm::ArrayRef<const char *> args, llvm::raw_ostream &stdoutOS, llvm::raw_ostream &stderrOS, bool exitEarly, bool disableOutput);
    }
    namespace mingw {
        bool link(llvm::ArrayRef<const char *> args, llvm::raw_ostream &stdoutOS, llvm::raw_ostream &stderrOS, bool exitEarly, bool disableOutput);
    }
}

// Argüman dizisini (char**) C++ vector yapısına dönüştüren yardımcı iç fonksiyon
std::vector<const char*> prepare_args(int argc, const char** argv, const char* flavor) {
    std::vector<const char*> args;
    args.push_back(flavor); // LLD sürücüleri ilk parametre olarak program adını/flavor'ı bekler
    for (int i = 0; i < argc; i++) {
        args.push_back(argv[i]);
    }
    return args;
}

extern "C" {
    // === 1. LINUX/FREEBSD ELF LINKER ===
    bool link_elf(int argc, const char** argv) {
        auto args = prepare_args(argc, argv, "ld.lld");
        return lld::elf::link(args, llvm::outs(), llvm::errs(), false, false);
    }

    // === 2. WINDOWS COFF LINKER (.exe/.dll) ===
    bool link_coff(int argc, const char** argv) {
        auto args = prepare_args(argc, argv, "lld-link");
        return lld::coff::link(args, llvm::outs(), llvm::errs(), false, false);
    }

    // === 3. macOS Mach-O LINKER ===
    bool link_macho(int argc, const char** argv) {
        auto args = prepare_args(argc, argv, "ld64.lld");
        return lld::macho::link(args, llvm::outs(), llvm::errs(), false, false);
    }

    // === 4. WebAssembly LINKER (.wasm) ===
    bool link_wasm(int argc, const char** argv) {
        auto args = prepare_args(argc, argv, "wasm-ld");
        return lld::wasm::link(args, llvm::outs(), llvm::errs(), false, false);
    }

    // === 5. MinGW WINDOWS LINKER ===
    bool link_mingw(int argc, const char** argv) {
        auto args = prepare_args(argc, argv, "ld.lld");
        return lld::mingw::link(args, llvm::outs(), llvm::errs(), false, false);
    }
}
