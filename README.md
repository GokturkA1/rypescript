# RypeScript

RypeScript, TypeScript sozluksel yapisini temel alarak statik tipli sistem programlama yaklasimini inceleyen, MLIR ve LLVM altyapisi uzerinde dogrudan yerel makine koduna (native binary) derlenen deneysel bir dildir.

Bu proje bir Proof of Concept (PoC) ve kisisel hobi calismasidir. Endustriyel uretim ortamlari icin tasarlanmamistir; ticari, kararlilik veya guvenlik garantisi sunmaz.

---

## 1. Mimari Genel Bakis

Derleyici, kaynak koddan calistirilabilir ikiliye kadar olan sureci asagidaki asamalarla yurutecek sekilde tasarlanmistir:

1. **Ayrirma (Frontend - `oxc-parser`):**
   TypeScript kaynak dosyalari, Rust tabanli OXC ayririci motoru kullanilarak ayririlir. C-FFI arayuzu (`oxc_parse_with_options`) uzerinden JSON/AST formati derleyiciye aktarilir.
2. **Semantik Analiz ve Tip Denetimi (`src/semantics`, `stage1/src/semantics`):**
   Modul bagimliliklari topolojik sira ile taranir. Iki gecisli semantik analiz mekanizmasi (imza toplama ve govde denetimi) calistirilarak statik tip dogrulamasi yapilir.
3. **MLIR Ara Temsili (Lowering - `src/ir`, `stage1/src/ir`):**
   Tip denetiminden gecen AST dugumleri MLIR (Multi-Level Intermediate Representation) lehcelerine (`func`, `arith`, `vector`, `llvm`, `cf`, `scf`) donusturulur. MLIR kodu diskte gecici dosya olusturulmadan bellek (RAM) uzerinde insa edilir.
4. **LLVM Kod Uretimi ve Optimizasyon (`src/engine`, `stage1/src/engine`):**
   MLIR modulu LLVM C-API araciligiyla LLVM IR seviyesine indirgenir. LLVM TargetMachine ile hedef islemci mimarisine uygun makine koduna (`.o`) derlenir.
5. **Baglama (Linker Bridge - `bridge.cpp`):**
   Entegre LLD suruculeri (ELF, COFF, Mach-O, Wasm, MinGW) kullanilarak nesne dosyalari sistem kutuphaneleri ile baglanir ve nihai calistirilabilir dosya uretilir.

---

## 2. Dizin Yapisi

Proje asagidaki ana bilesenlerden olusmaktadir:

```
rypescript/
├── src/            # Stage 0: Node.js ortaminda calisan referans derleyici
├── stage1/         # Stage 1: Saf RypeScript ile yazilmis self-hosting derleyici
├── oxc-parser/     # Rust tabanli C-FFI AST ayristirici kutuphanesi
├── bin/            # Derlenmis yerel derleyici ikilileri (rypec, rypec_stage2)
├── docs/           # Teknik sartname ve dil dokumantasyonu
├── bridge.cpp      # LLD kutuphanesini C-ABI uzerinden disa aktaran C++ koprusu
├── index.js        # Stage 0 CLI giris noktasi
├── rypescript.d.ts # IDE ve dil sunucusu icin ortam tip bildirimleri
├── tsconfig.json   # TypeScript yapilandirmasi
└── LICENSE         # GNU General Public License v3.0
```

---

## 3. Dil Ozellikleri Ozeti

Dilin tum kurallari, tipleri ve ornekleri [docs/SPECIFICATION.md](docs/SPECIFICATION.md) dosyasinda detaylandirilmistir. Temel yetenekler:

* **Statik Sayisal Tipler:** `i8`, `u8`, `i16`, `u16`, `i32`, `u32`, `i64`, `u64`, `f32`, `f64`, `usize`, `isize`, `bool`.
* **Isaretci Yonetimi:** `pointer` / `ptr` ile ham LLVM bellek erisimi.
* **Nesne Yonelimi:** Siniflar (`class`), tekli kalitim (`extends`), sanal metot tablosu (`vtable dynamic dispatch`), soyut siniflar (`abstract`).
* **Arayuzler (Interfaces):** Yapisal alt tipleme (duck typing) ve `itable` tabanli fat-pointer sanal cagrilari.
* **Birlikler (Unions):** Tagged Unions ve C-style sifir ek yuklu `Untagged<T>` (type-punning).
* **Bellek Modeli:**
  * Sahiplik semantigi: `move()`, `borrow()`.
  * RAII destegi: `using` anahtar sozcugu ve `[Symbol.dispose]` protokolü.
  * Ozel allokatörler: `Arena` (Bump Allocator), `Pool` (Slab Allocator), `FixedBuffer`.
  * Ham bellek intrinsics: `malloc`, `free`, `alloca`, `ptr_read_*`, `ptr_write_*`, `ptr_add`.
* **Hata Yonetimi:** C-ABI uyumlu sifir maliyetli `Result<T, E>` (`Ok`, `Err`, `unwrap`), `assert`, `panic`, `try`/`catch`.
* **Eszamanlilik:** POSIX tabanli `spawn` ve `join`, kilitli dairesel tampon ile calisan thread-safe `Channel<T>`, `async`/`await`.
* **Donanim Hizlandirma (SIMD):** MLIR Vector Dialect tabanli 128-bit/256-bit vektor tipleri (`f32x4`, `f64x2`, `i32x4`, `i64x2`), aritmetik ve reduksiyon islemleri.
* **C-FFI:** C basliklarini (`.h`) dogrudan import etme, harici kutuphaneleri (`.so`, `.dll`, `.dylib`) baglama, Node.js `@napi` eklentisi uretme, `@export_name`, `@inline`, `@packed`.

---

## 4. Baglama (Linking) Modlari

Derleyici, calistirilabilir ikilinin hedef ortamdaki tasinabilirligini belirlemek uzere uc farkli baglama modu sunar:

| Mod | Bayrak | Aciklama |
| :--- | :--- | :--- |
| **Dinamik (Varsayilan)** | `--dynamic` | Sistem dinamik kutuphanelerini (`.so`) kullanir. |
| **Tasinabilir Mod** | `--standalone` | `liboxc_parser.a`, LLVM/MLIR statik bilesenlerini ve `libstdc++` / `libgcc` calisma zamanini ikiliye gomer. Hedef sistemde yalnizca temel dinamik baglayici ve `libc.so` arar. |
| **Tam Bagimsiz Mod** | `--static` | `libc` dahil tum bilesenleri statik arsivlerden baglar (`-static`). Uretilen ikilinin dinamik baglayici bagimliligi bulunmaz. |

---

## 5. Komut Satiri Kullanimi

### 5.1. Stage 0 (Node.js Calistiricisi)

```bash
node index.js <giris_dosyasi.ts> [secenekler]
```

### 5.2. Stage 1 (Native Calistirici: `bin/rypec`)

```bash
./bin/rypec <giris_dosyasi.ts> [secenekler]
```

### 5.3. Ortak Secenekler

* `-o <dosya>`: Cikti dosyasinin adi (Varsayilan: `app_native`).
* `-t, --target <triple>`: Hedef mimari uclusu (ornek: `x86_64-pc-linux-gnu`, `wasm32-unknown-unknown`).
* `-f, --format <format>`: Cikti formati (`elf`, `so`, `node`, `coff`, `exe`, `dll`, `wasm`, `macho`, `dylib`).
* `--standalone`: Tasinabilir baglama modu.
* `--static`: Tam bagimsiz statik baglama modu.
* `--dynamic`: Dinamik baglama modu.
* `--dump-mlir`: Uretilen MLIR ara temsil kodunu standart ciktiya yazar.
* `--dump-llvm`: Uretilen LLVM IR kodunu standart ciktiya yazar.
* `--jit`: MCJIT uzerinden derleyip aninda calistirir.
* `--header [dosya]`: C baslik (.h) dosyasi uretir.

---

## 6. Derleme ve Self-Hosting Sureci

### 6.1. `oxc-parser` Derlemesi

Rust C-FFI kutuphanesini statik ve dinamik nesne olarak derlemek icin:

```bash
cd oxc-parser
cargo build --release
cd ..
```

Derleme sonucu `oxc-parser/target/release/` dizininde `liboxc_parser.a` ve `liboxc_parser.so` olusur. Bu dosyalar `bin/` dizinine kopyalanarak derleyici tarafindan erisilebilir hale getirilir.

### 6.2. LLD Baglayici Koprusu (`bridge.cpp`)

LLD C++ API'sini C-ABI uyumlu paylasimli kutuphaneye derlemek icin:

```bash
clang++ -O3 -shared -fPIC bridge.cpp -o libbridge.so $(llvm-config --cxxflags --ldflags --system-libs --libs lldCommon lldELF lldCOFF lldMachO lldWasm lldMinGW)
```

### 6.3. Stage 1 Derleyicisinin Stage 0 ile Derlenmesi

Node.js Stage 0 derleyicisi kullanilarak Stage 1 kaynak kodlarindan ilk native calistirilabilir dosya olusturulur:

```bash
node index.js stage1/main.ts -o bin/rypec --standalone -Lbin -L/opt/llvm-rype/lib
```

### 6.4. Stage 2 (Self-Hosting Dogrulamasi)

Stage 1 native derleyicisi (`bin/rypec`) kullanilarak Stage 1 kaynak kodlari tekrar derlenir ve Stage 2 ikilisi uretilir:

```bash
./bin/rypec stage1/main.ts -o bin/rypec_stage2 --standalone -Lbin -L/opt/llvm-rype/lib
```

---

## 7. Lisans

Bu proje [GNU General Public License v3.0 (GPLv3)](LICENSE) ile lisanslanmistir. Lisans kosullari icin `LICENSE` dosyasini inceleyiniz.
