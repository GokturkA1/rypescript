# RypeScript

RypeScript, TypeScript sözlüksel yapısını temel alarak statik tipli sistem programlama yaklaşımını inceleyen, MLIR ve LLVM altyapısı üzerinde doğrudan yerel makine koduna (native binary) derlenen deneysel bir dildir.

Bu proje bir Proof of Concept (PoC) ve kişisel hobi çalışmasıdır. Endüstriyel üretim ortamları için tasarlanmamıştır; ticari, kararlılık veya güvenlik garantisi sunmaz.

---

## 1. Mimari Genel Bakış

Derleyici, kaynak koddan çalıştırılabilir ikiliye kadar olan süreci aşağıdaki aşamalarla yürütecek şekilde tasarlanmıştır:

1. **Ayrıştırma (Frontend - `oxc-parser`):**
   TypeScript kaynak dosyaları, Rust tabanlı OXC ayrıştırıcı motoru kullanılarak ayrıştırılır. C-FFI arayüzü (`oxc_parse_with_options`) üzerinden JSON/AST formatı derleyiciye aktarılır.
2. **Semantik Analiz ve Tip Denetimi (`src/semantics`, `stage1/src/semantics`):**
   Modül bağımlılıkları topolojik sıra ile taranır. C başlık dosyaları (`.h`) taranarak fonksiyon prototipleri çözülür. İki geçişli semantik analiz mekanizması (imza toplama ve gövde denetimi) çalıştırılarak statik tip doğrulaması yapılır.
3. **MLIR Ara Temsili (Lowering - `src/ir`, `stage1/src/ir`):**
   Tip denetiminden geçen AST düğümleri MLIR (Multi-Level Intermediate Representation) lehçelerine (`func`, `arith`, `vector`, `llvm`, `cf`, `scf`) dönüştürülür. MLIR kodu diskte geçici dosya oluşturulmadan bellek (RAM) üzerinde doğrudan inşa edilir.
4. **LLVM Kod Üretimi ve Optimizasyon (`src/engine`, `stage1/src/engine`):**
   MLIR modülü LLVM C-API aracılığıyla LLVM IR seviyesine indirgenir. LLVM TargetMachine ile hedef işlemci mimarisine uygun makine koduna (`.o`) derlenir.
5. **Bağlama (Linker Bridge - `bridge.cpp`):**
   Entegre LLD sürücüleri (ELF, COFF, Mach-O, Wasm, MinGW) kullanılarak nesne dosyaları, belirtilen arama dizinleri (`-L`) ve kütüphaneler (`-l`) ile bağlanarak nihai çalıştırılabilir dosya üretilir.

---

## 2. Dizin Yapısı

Proje aşağıdaki ana bileşenlerden oluşmaktadır:

```
rypescript/
├── src/            # Stage 0: Node.js ortamında çalışan referans derleyici
├── stage1/         # Stage 1: Saf RypeScript ile yazılmış self-hosting derleyici
├── oxc-parser/     # Rust tabanlı C-FFI AST ayrıştırıcı kütüphanesi
├── bin/            # Derlenmiş yerel derleyici ikilileri (rypec, rypec_stage2)
├── docs/           # Teknik şartname ve dil dokümantasyonu
├── bridge.cpp      # LLD kütüphanesini C-ABI üzerinden dışa aktaran C++ köprüsü
├── index.js        # Stage 0 CLI giriş noktası
├── rypescript.d.ts # IDE ve dil sunucusu için ortam tip bildirimleri
├── tsconfig.json   # TypeScript yapılandırması
└── LICENSE         # GNU General Public License v3.0
```

---

## 3. Dil Yetenekleri ve Özellikleri

Dilin tüm kuralları, sözdizimi ve örnekleri [docs/SPECIFICATION.md](docs/SPECIFICATION.md) dosyasında detaylandırılmıştır. Temel yetenekler:

* **Statik Sayısal Tipler:** `i8`, `u8`, `i16`, `u16`, `i32`, `u32`, `i64`, `u64`, `f32`, `f64`, `usize`, `isize`, `bool`.
* **İşaretçi Yönetimi:** `pointer` / `ptr` ile ham LLVM bellek erişimi ve adres aritmetiği.
* **Nesne Yönelimi:** Sınıflar (`class`), tekli kalıtım (`extends`), sanal metot tablosu (`vtable dynamic dispatch`), soyut sınıflar (`abstract`).
* **Arayüzler (Interfaces):** Yapısal alt tipleme (duck typing) ve `itable` tabanlı fat-pointer sanal çağrıları.
* **Birlikler (Unions):** Tagged Unions ve C-style sıfır ek yüklü `Untagged<T>` (type-punning).
* **Bellek Modeli ve RAII:**
  * Sahiplik semantiği: `move()`, `borrow()`.
  * Deterministik RAII: `using` anahtar sözcüğü ve `[Symbol.dispose]` protokolü ile kapsamdan çıkışta otomatik kaynak iadesi.
  * Özel allokatörler: `Arena` (Bump Allocator), `Pool` (Slab Allocator), `FixedBuffer`.
  * Ham bellek intrinsics: `malloc`, `free`, `alloca`, `ptr_read_*`, `ptr_write_*`, `ptr_add`.
* **Hata Yönetimi ve Kontrol Akışı:**
  * Sıfır maliyetli deterministik `Result<T, E>` (`Ok`, `Err`, `unwrap`).
  * Sav ve panik: `assert`, `panic`.
  * `try` / `catch` / `finally`: `catch` olmadan tanımlanan `try ... finally` blokları sıfır maliyetli kapsam ertelemesi (`defer`) olarak çalışır. `finally` bloğu, hata fırlatılsın veya erken `return` yapılsın, kaynakların mutlak surette temizlenmesini garanti eder.
* **Derleyici Pragmatikleri ve Dekoratörler:**
  * `@inline`: Fonksiyonu satır içine zorlar (LLVM `alwaysinline`).
  * `@noinline`: Satır içine gömmeyi engeller (LLVM `noinline`).
  * `@packed`: Yapı alanları arasındaki hizalama dolgusunu kaldırarak sıkıştırır.
  * `@export_name("c_sym")`: Fonksiyonu saf C sembol adı ile dışa aktarır (C-ABI alias).
  * `@napi`: Node.js yerel eklentisi (`.node`) uyumlu N-API köprüsü üretir.
  * `@unique`: İşaretçiyi tekil sahiplikli olarak işaretler (no-alias optimizasyonu).
* **C-FFI ve Dış Entegrasyon:**
  * C başlıklarını (`.h`) doğrudan içe aktarma (`import { puts } from "./stdio.h"`).
  * Paylaşımlı kütüphaneleri (`.so`, `.dll`, `.dylib`) doğrudan `import` ile bağlayıcıya bildirme.
* **Eşzamanlılık:** POSIX tabanlı `spawn` ve `join`, kilitli dairesel tampon ile çalışan thread-safe `Channel<T>`, `async`/`await`.
* **Donanım Hızlandırma (SIMD):** MLIR Vector Dialect tabanlı 128-bit/256-bit vektör tipleri (`f32x4`, `f64x2`, `i32x4`, `i64x2`), aritmetik, FMA ve redüksiyon işlemleri.

---

## 4. Bağlama (Linking) Modları

Derleyici, çalıştırılabilir ikilinin hedef ortamdaki taşınabilirliğini belirlemek üzere üç farklı bağlama modu sunar:

| Mod | Bayrak | Açıklama |
| :--- | :--- | :--- |
| **Dinamik (Varsayılan)** | `--dynamic` | Sistem dinamik kütüphanelerini (`.so`) kullanır. |
| **Taşınabilir Mod** | `--standalone` | `liboxc_parser.a`, LLVM/MLIR statik bileşenlerini ve `libstdc++` / `libgcc` çalışma zamanını ikiliye gömer. Hedef sistemde yalnızca temel dinamik bağlayıcı ve `libc.so` arar. |
| **Tam Bağımsız Mod** | `--static` | `libc` dahil tüm bileşenleri statik arşivlerden bağlar (`-static`). Üretilen ikilinin dinamik bağlayıcı bağımlılığı bulunmaz (`not a dynamic executable`). |

---

## 5. Komut Satırı Kullanımı ve Bağlayıcı Bayrakları

### 5.1. Stage 0 (Node.js Çalıştırıcısı)

```bash
node index.js <giris_dosyasi.ts> [secenekler]
```

### 5.2. Stage 1 (Native Çalıştırıcı: `bin/rypec`)

```bash
./bin/rypec <giris_dosyasi.ts> [secenekler]
```

### 5.3. Seçenekler ve Bayraklar

* `-o <dosya>`: Çıktı dosyasının adı (Varsayılan: `app_native`).
* `-t, --target <triple>`: Hedef mimari üçlüsü (örnek: `x86_64-pc-linux-gnu`, `wasm32-unknown-unknown`).
* `-f, --format <format>`: Çıktı formatı (`elf`, `so`, `node`, `coff`, `exe`, `dll`, `wasm`, `macho`, `dylib`).
* `-L<dizin>`: LLD bağlayıcısına kütüphane arama dizini ekler (örnek: `-Lbin`, `-L/opt/llvm-rype/lib`).
* `-l<kütüphane>`: LLD bağlayıcısına bağlanacak harici kütüphaneyi bildirir (örnek: `-lm`, `-lpthread`, `-loxc_parser`).
* `--standalone`: Taşınabilir bağlama modu.
* `--static`: Tam bağımsız statik bağlama modu.
* `--dynamic`: Dinamik bağlama modu.
* `--dump-mlir`: Üretilen MLIR ara temsil kodunu standart çıktıya yazar.
* `--dump-llvm`: Üretilen LLVM IR kodunu standart çıktıya yazar.
* `--jit`: MCJIT üzerinden derleyip anında çalıştırır.
* `--header [dosya]`: C başlık (.h) dosyası üretir.

---

## 6. Derleme ve Self-Hosting Süreci

### 6.1. `oxc-parser` Derlemesi

Rust C-FFI kütüphanesini statik ve dinamik nesne olarak derlemek için:

```bash
cd oxc-parser
cargo build --release
cd ..
```

Derleme sonucu `oxc-parser/target/release/` dizininde `liboxc_parser.a` ve `liboxc_parser.so` oluşur. Bu dosyalar `bin/` dizinine kopyalanarak derleyici tarafından erişilebilir hale getirilir.

### 6.2. LLD Bağlayıcı Köprüsü (`bridge.cpp`)

LLD C++ API'sini C-ABI uyumlu paylaşımlı kütüphaneye derlemek için:

```bash
clang++ -O3 -shared -fPIC bridge.cpp -o libbridge.so $(llvm-config --cxxflags --ldflags --system-libs --libs lldCommon lldELF lldCOFF lldMachO lldWasm lldMinGW)
```

### 6.3. Stage 1 Derleyicisinin Stage 0 ile Derlenmesi

Node.js Stage 0 derleyicisi kullanılarak Stage 1 kaynak kodlarından ilk native çalıştırılabilir dosya oluşturulur:

```bash
node index.js stage1/main.ts -o bin/rypec --standalone -Lbin -L/opt/llvm-rype/lib
```

### 6.4. Stage 2 (Self-Hosting Doğrulaması)

Stage 1 native derleyicisi (`bin/rypec`) kullanılarak Stage 1 kaynak kodları tekrar derlenir ve Stage 2 ikilisi üretilir:

```bash
./bin/rypec stage1/main.ts -o bin/rypec_stage2 --standalone -Lbin -L/opt/llvm-rype/lib
```

---

## 7. Lisans

Bu proje [GNU General Public License v3.0 (GPLv3)](LICENSE) ile lisanslanmıştır. Lisans koşulları için `LICENSE` dosyasını inceleyiniz.
