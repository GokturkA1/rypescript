# RypeScript Dil Şartnamesi (Language Specification)

Bu doküman, RypeScript dilinin sözlüksel, anlamsal, tip sistemi, bellek yönetimi, eşzamanlılık, donanım hızlandırma, derleyici pragmaları ve dış ortam bağlantı (FFI) yeteneklerini teknik ayrıntılarıyla tanımlar.

Bu proje bir Proof of Concept (PoC) ve kişisel hobi çalışmasıdır; endüstriyel üretim ortamları için tasarlanmamıştır ve kararlılık/güvenlik garantisi taşımaz.

---

## 1. Tip Sistemi ve Primitifler

RypeScript, statik olarak tiplenen ve doğrudan LLVM/MLIR tiplerine karşılık gelen bir tür hiyerarşisine sahiptir.

### 1.1. Skaler Sayısal Tipler

| Tip | Bit Genişliği | LLVM Karşılığı | Açıklama |
| :--- | :--- | :--- | :--- |
| `i8` | 8-bit | `i8` | İşaretli tamsayı (-128 .. 127) |
| `u8` / `byte` | 8-bit | `i8` | İşaretsiz tamsayı (0 .. 255) |
| `i16` | 16-bit | `i16` | İşaretli 16-bit tamsayı |
| `u16` | 16-bit | `i16` | İşaretsiz 16-bit tamsayı |
| `i32` / `int` | 32-bit | `i32` | İşaretli 32-bit tamsayı (C `int` uyumlu) |
| `u32` | 32-bit | `i32` | İşaretsiz 32-bit tamsayı |
| `i64` | 64-bit | `i64` | İşaretli 64-bit tamsayı |
| `u64` | 64-bit | `i64` | İşaretsiz 64-bit tamsayı |
| `f32` / `float` | 32-bit | `f32` | Tek duyarlıklı kayan noktalı sayı (IEEE 754) |
| `f64` / `double` | 64-bit | `f64` | Çift duyarlıklı kayan noktalı sayı (IEEE 754) |
| `usize` | Mimari bağımlı | `i64` (x86_64) | İşaretçi genişliğinde işaretsiz tamsayı |
| `isize` | Mimari bağımlı | `i64` (x86_64) | İşaretçi genişliğinde işaretli tamsayı |
| `bool` / `boolean`| 1-bit | `i1` | Mantıksal doğruluk değeri (`true` / `false`) |
| `number` | 64-bit | `f64` / `i32` | TypeScript uyumluluk sayısal tipi |

### 1.2. İşaretçi ve Bellek Tipleri

* **`pointer` / `ptr`:** Ham LLVM işaretçisini (`!llvm.ptr`) temsil eder. C seviyesinde bellek adreslerini, FFI çağrı parametrelerini ve dinamik tahsisatları tutar. Statik tip denetiminden muaftır ve doğrudan adres aritmetiğine olanak tanır.

### 1.3. Özel Tipler

* **`void`:** Dönüş değeri bulunmayan fonksiyonları tanımlar.
* **`never`:** Çalışması sonlanan veya panik üreten fonksiyonların dönüş tipidir.
* **`any`:** Statik tip denetimini devre dışı bırakan geçiş tipidir.

---

## 2. Nesne Yönelimli Programlama ve Veri Yapıları

### 2.1. Sınıflar (Classes)

RypeScript sınıfları, bellekte düz C struct düzenine benzer biçimde yerleşir:

* **Alanlar ve Başlatma:** Sınıf gövdesinde tanımlanan alanlar tanımlanma sırasıyla bellek ofsetlerine atanır.
* **Kurucu (`constructor`):** Nesne örneklenirken (`new Cls(...)`) çağrılır; heap üzerinde sınıf boyutu kadar alan tahsis edilir ve kurucu işletilir.
* **Statik Üyeler:** Sınıf örneğinden bağımsız, global sembol tablosuna bağlanan fonksiyon ve alanlardır.
* **Kalıtım (`extends`):** Tekli kalıtımı destekler. Üst sınıfın tüm alanları alt sınıf bellek düzeninin başına yerleştirilir (`super(...)` ile üst kurucu çağrısı zorunludur).
* **Soyut Sınıflar (`abstract`):** Doğrudan örneklenemez, yalnızca türetilmek üzere şablon oluşturur.

```typescript
class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  makeSound(): void {
    // taban davranış
  }
}

class Dog extends Animal {
  barkCount: i32;
  constructor(name: string) {
    super(name);
    this.barkCount = 0;
  }
  override makeSound(): void {
    this.barkCount = this.barkCount + 1;
  }
}
```

### 2.2. Sanal Metot Yönlendirmesi (Vtable Dispatch)

Çok biçimlilik (polymorphism), sanal metot tablosu (vtable) aracılığıyla çalışma zamanında dolaylı çağrı (`indirect call`) olarak yürütülür:

* Alt sınıf tarafından ezilen (override) metotlar, taban sınıf göstericisi üzerinden çağrıldığında nesnenin başındaki vtable göstericisi üzerinden çözümlenir.

### 2.3. Arayüzler ve Yapısal Alt Tipleme (Structural Typing / Duck Typing)

Arayüzler (Interfaces), sınıflar arasında açık bir `implements` bildirimi olmasa dahi yapısal uyumluluğu destekler:

* **`itable` (Interface Table) ve Fat Pointer:** Bir nesne bir arayüz referansına atandığında, derleyici iki işaretçiden oluşan bir fat pointer oluşturur:
  1. Nesne örneğine işaret eden veri göstericisi (`data pointer`).
  2. Arayüz metotlarının gerçek adreslerini içeren sanal arayüz tablosu (`itable pointer`).

```typescript
interface Writer {
  write(data: string): i32;
}

class FileWriter {
  write(data: string): i32 {
    // yazma işlemi
    return 1;
  }
}

function processOutput(w: Writer): void {
  w.write("veri");
}

let fw = new FileWriter();
processOutput(fw); // Yapısal alt tipleme ile otomatik fat pointer sarmalama
```

### 2.4. Tagged Unions ve Untagged Unions

* **Tagged Unions (Etiketli Birlikler):**
  Farklı tiplerin çalışma zamanında bir etiket (`discriminant`) ile ayırt edilmesini sağlar. `typeof`, `instanceof` veya `in` operatörleri ile tip daraltma (type narrowing) uygulanır.

* **Untagged Unions (`Untagged<T>`):**
  C birliği (union) mantığıyla çalışır. Tüm alanlar bellek ofseti olarak sıfırıncı (0.) baytı paylaşır. Hiçbir etiket ya da ek yük barındırmaz (type-punning için kullanılır).

```typescript
type HardwareRegister = Untagged<{
  asU32: u32;
  asBytes: u8[];
}>;
```

### 2.5. Jenerikler (Parametrik Çok Biçimlilik)

Sınıflar, arayüzler ve fonksiyonlar generic tip parametreleri (`<T, U>`) kabul eder. Tip parametreleri semantik analiz sırasında somut tiplerle eşlenir.

---

## 3. Bellek Yönetimi, Sahiplik ve RAII

RypeScript, çöp toplayıcı (garbage collector) çalışma zamanı maliyeti olmadan bellek güvenliği ve esnekliği sağlamak amacıyla çok katmanlı bir bellek yönetimi sunar.

### 3.1. Sahiplik ve Ödünç Alma (Ownership & Borrowing)

* **`move(target)`:**
  Bir değişkenin tuttuğu kaynağın sahipliğini başka bir değişkene veya kapsama taşır. Taşınan kaynak artık eski değişken üzerinden erişilemez (`use-after-move` statik ve çalışma zamanı denetimi). Kaynak yeni sahibine devredildiğinden eski sahibin çift serbest bırakma (`double-free`) yapması engellenir.

* **`borrow(target)`:**
  Kaynağın sahipliği devredilmeden, salt-okunur referans olarak fonksiyonlara aktarılmasını sağlar.

```typescript
let buffer = malloc(1024);
let transferred = move(buffer);
// buffer artık kullanılamaz; transferred geçerlidir.
```

### 3.2. Deterministic RAII ve `using` Anahtar Sözcüğü

TypeScript'in `using` anahtar sözcüğü (`Explicit Resource Management`), derleyicinin kapsam yığını (scope stack) ile doğrudan entegredir:

* **Çalışma Prensibi:** `using` ile tanımlanan bir değişken bildirildiğinde, derleyici bu değişkeni geçerli kapsamın serbest bırakılabilirler listesine (`trackDisposable`) kaydeder.
* **Kapsam Çıkışı Temizliği:** Kapsamdan (blok sonu, fonksiyon sonu, döngü sonu veya erken `return`) çıkıldığında, derleyici nesne üzerindeki `[Symbol.dispose]()` veya allokatörün `dispose()` metodunu otomatik olarak çağırır.
* Manuel `free()` veya kaynak iadesi yazma ihtiyacını ortadan kaldırır.

```typescript
{
  using arena = new Arena(4096);
  let ptr = arena.alloc(64);
  // Kapsam kapandığında arena.dispose() derleyici tarafından otomatik çağrılır.
}
```

### 3.3. Bölgesel ve Özel Bellek Yöneticileri (Allocators)

1. **`Arena` (Bump Allocator):**
   * Sıralı, parçalanmasız bellek ayırıcı. İşaretçi yalnızca ileri kayar.
   * `alloc(sizeBytes: number): pointer`
   * `reset(): void`: İşaretçiyi başa sararak tüm tahsisatları sıfır maliyetle anında geri kazanır.
   * `dispose(): void`: Arenanın tuttuğu ana bellek bloğunu işletim sistemine iade eder.
   * `[Symbol.dispose]()`: RAII desteği sağlar.

2. **`Pool` (Slab Allocator):**
   * Sabit boyutlu blok havuzu.
   * `alloc(): pointer`: Havuzdan boşta duran bir bloğu sabit sürede ($O(1)$) tahsis eder.
   * `free(ptr: pointer): void`: Bloğu havuza geri kabul eder.
   * `dispose(): void`: Tüm havuz sayfalarını serbest bırakır.

3. **`FixedBuffer`:**
   * Sınırlı, sabit kapasiteli deterministik tampon. Kapasite aşımında program kontrollü olarak trap/abort üretir.

### 3.4. Düşük Seviyeli Bellek Intrinsics

C seviyesinde doğrudan bellek manipülasyonu için yerleşik fonksiyonlar sunulur:

* `malloc(sizeBytes: number): pointer`: Ham heap tahsisi.
* `free(ptr: pointer): void`: Tahsis edilmiş bloğu serbest bırakma.
* `alloca(sizeBytes: number): pointer`: Geçerli fonksiyonun yığın çerçevesinde (stack frame) dinamik alan açar; fonksiyon dönüşünde sıfır maliyetle geri kazanılır.
* `ptr_read_u8(ptr, offset?)`, `ptr_write_u8(ptr, offset, val)`: 8-bit ham bellek okuma/yazma.
* `ptr_read_i32(ptr, offset?)`, `ptr_write_i32(ptr, offset, val)`: 32-bit tamsayı okuma/yazma.
* `ptr_read_f64(ptr, offset?)`, `ptr_write_f64(ptr, offset, val)`: 64-bit float okuma/yazma.
* `ptr_add(ptr, byteOffset): pointer`: İşaretçi aritmetiği ile bayt ofseti ekleme.

---

## 4. Hata Yönetimi ve Kontrol Akışı

### 4.1. `Result<T, E>` Modeli

C-ABI düzeyinde çalışan, sıfır maliyetli başarı/hata sarmalayıcısıdır:

* `Ok<T>(val: T): Result<T, E>`: Başarılı sonuç sarmalar (`ok = true`).
* `Err<E>(err: E): Result<T, E>`: Hata değeri sarmalar (`ok = false`).
* `unwrap<T>(res: Result<T, E>): T`: Sonuç hatalıysa programı panik ile sonlandırır; başarılıysa değeri döner.

```typescript
function divide(a: f64, b: f64): Result<f64, string> {
  if (b === 0.0) {
    return Err("Sıfıra bölme hatası");
  }
  return Ok(a / b);
}

let r = divide(10.0, 2.0);
if (r.ok) {
  let val = r.value;
}
```

### 4.2. Sav ve Panik

* **`panic(message?: string): never`:** Kurtarılamaz hata durumunda programı anında LLVM abort/trap durumuna geçirerek sonlandırır.
* **`assert(condition: boolean, message?: string)`:** Koşul `false` ise panik üretir.

### 4.3. İstisnalar (`try` / `catch` / `finally`) ve `finally` Kullanım Amacı

RypeScript, yerel makine kodu seviyesinde istisna yönetimini iki farklı strateji ile ele alır:

1. **Sıfır Maliyetli `defer` Modu (`try { ... } finally { ... }`):**
   * Eğer bir `try` bloğunda `catch` tanımlanmamış, yalnızca `finally` tanımlanmışsa derleyici bunu `setjmp`/`longjmp` maliyetine girmeden doğrudan bir **kapsam erteleme (`deferral`)** işlemi olarak derler.
   * `try` bloğu ister normalamlansın, ister içeride erken bir `return`, `break` veya `continue` çalışsın, `finally` bloğu kapsamdan çıkış anında kesinlikle ve sıfır ek yükle çalıştırılır.

2. **Dinamik İstisna Yakalama Modu (`try { ... } catch (e) { ... } finally { ... }`):**
   * İstisnalar `setjmp` ve `longjmp` temelli yerel mekanizma ile yönetilir.
   * `throw` ifadesi global istisna yuvasına hata değerini yazar ve etkin `jmp_buf` hedefine atlar.
   * `finally` bloğunun temel kullanım amacı:
     * **Kaynak Güvenliği:** Bir hata fırlatılsa veya fonksiyon erken sonlandırılsa dahi açık dosyaların (`fclose`), soketlerin, kilitlerin (`mutex_unlock`) veya geçici belleklerin mutlak surette serbest bırakılmasını sağlamak.
     * **Değişmezlerin Korunması (Invariants):** Hata durumunda dahi sistem durumunun tutarlı bir aşamaya geri getirilmesi.

```typescript
let fp = fopen("data.bin", "rb");
try {
  // Veri işleme; hata oluşabilir veya erken return yapılabilir
  if (fp === null) throw "Dosya açılamadı";
} finally {
  // Hata olsa da olmasa da dosya mutlak surette kapatılır
  if (fp !== null) fclose(fp);
}
```

---

## 5. Eşzamanlılık ve Çoklu İş Parçacığı (Concurrency)

### 5.1. İşletim Sistemi İş Parçacıkları (`spawn` / `join`)

POSIX pthread tabanlı yerel iş parçacığı başlatma ve bekleme:

* `spawn(worker, arg): ThreadHandle`: Bağımsız bir işletim sistemi thread'i başlatır.
* `join(handle): void`: İş parçacığının tamamlanmasını bekler ve sistem kaynaklarını temizler.

### 5.2. `Channel<T>` (Thread-Safe Kanal)

İş parçacıkları arasında kilitli ve güvenli FIFO iletişimi sağlar:

* `pthread_mutex` ve `pthread_cond` tabanlı dairesel tampon mimarisi.
* `send(value: T): void`: Kanala veri yazar (kanal doluysa iş parçacığını kilitler).
* `recv(): T`: Kanaldan veri okur (kanal boşsa veri gelene kadar kilitler).
* `close(): void`: Kanalı kapatır ve bekleyen tüm iş parçacıklarını uyandırır.

### 5.3. Asenkron Programlama (`async` / `await` / `Promise<T>`)

* `async` fonksiyonlar arka planda bir görev bağlamı oluşturur.
* `await` ifadesi asenkron görevin sonucunu senkronize eder.

---

## 6. Donanım Hızlandırma ve SIMD (Vector Dialect)

RypeScript, MLIR Vector Dialect üzerinden 128-bit ve 256-bit SIMD tiplerini birinci sınıf vatandaş olarak destekler:

### 6.1. Desteklenen Vektör Tipleri

* `f32x4`: 4 adet 32-bit kayan noktalı sayı (128-bit)
* `f64x2`: 2 adet 64-bit çift duyarlıklı sayı (128-bit)
* `i32x4`: 4 adet 32-bit tamsayı (128-bit)
* `i64x2`: 2 adet 64-bit tamsayı (128-bit)

### 6.2. SIMD İşlemleri

* **`splat(scalar)`:** Skaler bir değeri tüm vektör şeritlerine kopyalar.
* **`load(ptr)` / `store(ptr, vec)`:** Ham bellekten vektörel yükleme ve kaydetme.
* **Aritmetik:** `add`, `sub`, `mul`, `div`.
* **FMA:** `fma(a, b, c)` (Fused Multiply-Add: `a * b + c`).
* **İndirgeme (Reduction):** `reduce_add`, `reduce_mul`, `reduce_min`, `reduce_max`.
* **Şerit Erişimi:** `extract(vec, idx)`, `insert(vec, idx, val)`.
* **Matematik:** `sqrt`, `abs`.

```typescript
let a = f32x4(1.0, 2.0, 3.0, 4.0);
let b = f32x4(5.0, 6.0, 7.0, 8.0);
let c = f32x4.add(a, b);
let sum: f32 = f32x4.reduce_add(c);
```

---

## 7. Derleyici Dekorötörleri ve Pragmatikleri

RypeScript, fonksiyonların ve veri tiplerinin LLVM seviyesindeki kod üretimini yönlendirmek üzere özel dekoratör/pragma desteği sunar:

### 7.1. `@inline` ve `@noinline`

* **`@inline`:** Fonksiyon çağrısını kaldırarak fonksiyon gövdesini çağrıldığı yere doğrudan kopyalar (LLVM `alwaysinline` özniteliği). Çağrı ek yükünü sıfırlar.
* **`@noinline`:** Fonksiyonun satır içine gömülmesini kesin olarak engeller (LLVM `noinline` özniteliği). Hata ayıklama veya ikili boyutunu optimize etme amacıyla kullanılır.

### 7.2. `@packed`

C struct veya sınıf tanımlarında alanlar arası mimari hizalama dolgusunu (`padding`) tamamen kaldırır. Verileri bayt bayt sıkıştırarak ağ paketleri veya ikili dosya başlıkları için ideal bellek düzeni oluşturur.

### 7.3. `@export_name("c_symbol")`

RypeScript fonksiyonunun dışarıya aktarılacak saf C sembol adını belirler (C-ABI export alias). İsim karıştırma (name mangling) uygulanmaz; harici C/C++ kodları veya dinamik yükleyiciler bu sembole doğrudan ulaşabilir.

```typescript
@export_name("calculate_hash")
function hashData(buf: pointer, len: i64): u64 {
  // C uyumlu sembol olarak üretilir
  return 0;
}
```

### 7.4. `@napi`

Fonksiyonu doğrudan bir Node.js C++ eklentisi (`.node`) olarak dışa aktaran N-API bağlayıcı sarmalayıcısı üretir. JavaScript ortamından doğrudan çağrılabilir yerel eklentiler geliştirmek için kullanılır.

### 7.5. `@unique`

Bir işaretçinin veya kaynağın tekil sahipliğe sahip olduğunu (unique pointer) ve takma adlandırılmadığını (no-alias) belirterek LLVM'in daha agresif optimizasyonlar yapmasını sağlar.

---

## 8. C-FFI ve Harici Entegrasyonlar

RypeScript, C ekosistemiyle sıfır maliyetli ve doğrudan etkileşim kuracak şekilde tasarlanmıştır.

### 8.1. C Başlık Dosyalarını (`.h`) Doğrudan İçe Aktarma

C `.h` başlık dosyaları, ayrı bir binding yazmaya gerek kalmadan doğrudan TypeScript modülü gibi içe aktarılabilir:

```typescript
import { fopen, fclose, fread, fwrite } from "./stdio.h";
```

* **Başlık Ayrıştırıcı (Header Scraper):** Derleyicinin semantik analizörü başlık dosyasındaki fonksiyon prototiplerini tarar, makroları ve yorumları ayıklar.
* **Otomatik Tip Dönüşümü:**
  * `char*` $\rightarrow$ `string`
  * `void*`, `T*` $\rightarrow$ `pointer`
  * `int`, `long`, `double`, `float` $\rightarrow$ sayısal tipler (`number` / `i32` / `f64`)
  * `void` $\rightarrow$ `void`
* İçe aktarılan C fonksiyonları `llvm.func` olarak harici sembol biçiminde derleme hattına dahil edilir.

### 8.2. Paylaşımlı Kütüphaneleri (`.so`, `.dll`, `.dylib`) İçe Aktarma

Dinamik kütüphaneler doğrudan `import` satırıyla bildirilebilir:

```typescript
import "./libm.so";
import "./libcrypto.so";
```

`ModuleResolver` bu dosyaları derleme grafiğinde tespit eder ve LLD bağlayıcısının komut satırı argümanlarına otomatik olarak ekler.

---

## 9. Bağlayıcı Bayrakları ve Arama Yolları (`-L`, `-l`)

Derleme sırasında harici kütüphanelerin ve dizinlerin bağlanması için komut satırından standart bağlayıcı bayrakları desteklenir:

* **`-L<dizin>`:** Bağlayıcıya kütüphane arama dizini ekler (örneğin: `-Lbin`, `-L/opt/llvm-rype/lib`).
* **`-l<kütüphane>`:** Bağlayıcıya belirli bir sistem veya kullanıcı kütüphanesini bağlamasını bildirir (örneğin: `-lm`, `-lpthread`, `-lstdc++`, `-loxc_parser`).

Bu bayraklar hem Stage 0 (`index.js`) hem de Stage 1 (`stage1/main.ts`) üzerinden toplanır ve `CompilerEngine` aracılığıyla doğrudan gömülü LLD sürücüsüne iletilir.
