# RypeScript Dil Sartnamesi (Language Specification)

Bu dokuman, RypeScript dilinin sozluksel, anlamsal, tip sistemi, bellek yonetimi, eszamanlilik, donanim hizlandirma ve dis ortam baglanti (FFI) yeteneklerini teknik ayrintilariyla tanimlar.

Bu proje bir Proof of Concept (PoC) ve kisisel hobi calismasidir; endustriyel uretim ortamlari icin tasarlanmamistir ve boyle bir garanti tasimaz.

---

## 1. Tip Sistemi ve Primitifler

RypeScript, statik olarak tiplenen ve dogrudan LLVM/MLIR tiplerine karsilik gelen zengin bir tur hiyerarsisine sahiptir.

### 1.1. Skaler Sayisal Tipler

| Tip | Bit Genisligi | LLVM Karsiligi | Aciklama |
| :--- | :--- | :--- | :--- |
| `i8` | 8-bit | `i8` | Isaretli tamsayi (-128 .. 127) |
| `u8` / `byte` | 8-bit | `i8` | Isaretsiz tamsayi (0 .. 255) |
| `i16` | 16-bit | `i16` | Isaretli 16-bit tamsayi |
| `u16` | 16-bit | `i16` | Isaretsiz 16-bit tamsayi |
| `i32` / `int` | 32-bit | `i32` | Isaretli 32-bit tamsayi (C `int` uyumlu) |
| `u32` | 32-bit | `i32` | Isaretsiz 32-bit tamsayi |
| `i64` | 64-bit | `i64` | Isaretli 64-bit tamsayi |
| `u64` | 64-bit | `i64` | Isaretsiz 64-bit tamsayi |
| `f32` / `float` | 32-bit | `f32` | Tek duyarlikli kayan noktali sayi (IEEE 754) |
| `f64` / `double` | 64-bit | `f64` | Cift duyarlikli kayan noktali sayi (IEEE 754) |
| `usize` | Mimari bagimli | `i64` (x86_64) | Isaretci genisliginde isaretsiz tamsayi |
| `isize` | Mimari bagimli | `i64` (x86_64) | Isaretci genisliginde isaretli tamsayi |
| `bool` / `boolean`| 1-bit | `i1` | Mantiksal dogruluk degeri (`true` / `false`) |
| `number` | 64-bit | `f64` / `i32` | TypeScript uyumluluk sayisal tipi |

### 1.2. Isaretci ve Bellek Tipleri

* **`pointer` / `ptr`:** Ham LLVM isaretcisini (`!llvm.ptr`) temsil eder. C seviyesinde bellek adreslerini, FFI cagri parametrelerini ve dinamik tahsisatlari tutar. Tip guvenligi denetiminden muaftir.

### 1.3. Ozel Tipler

* **`void`:** Donus degeri olmayan fonksiyonlari tanimlar.
* **`never`:** Calismasi sonlanan veya panik ureten fonksiyonlarin donus tipidir.
* **`any`:** Statik tip denetimini devre disi birakan gecis tipidir.

---

## 2. Nesne Yonelimli Programlama ve Veri Yapilari

### 2.1. Siniflar (Classes)

RypeScript siniflari, C++ sinif duzenine benzer bicimde bellekte duz struct olarak yerlesir:

* **Alanlar ve Baslatma:** Sinif govdesinde tanimlanan alanlar sira ile bellek ofsetlerine atanir.
* **Kurucu (`constructor`):** Nesne orneklenirken (`new Cls(...)`) cagirilir; heap uzerinde sinif boyutu kadar alan tahsis edilir ve kurucu isletilir.
* **Statik Uyeler:** Sinif orneginden bagimsiz, global sembol tablosuna baglanan fonksiyon ve alanlardir.
* **Kalitim (`extends`):** Tekli kalitimi destekler. Ust sinifin tum alanlari alt sinif bellek duzeninin basina yerlestirilir.
* **Soyut Siniflar (`abstract`):** Dogrudan orneklenemez, yalnizca turetilmek uzere sablon olusturur.

```typescript
class Animal {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  makeSound(): void {
    // taban davranis
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

### 2.2. Sanal Metot Yonlendirmesi (Vtable Dispatch)

Cok bicimlilik (polymorphism), sanal metot tablosu (vtable) araciligiyla calisma zamaninda dolayli cagri (`indirect call`) olarak yurutulur:

* Alt sinif tarafindan ezilen (override) metotlar, taban sinif gostericisi uzerinden cagirildiginda nesnenin basindaki vtable gostericisi uzerinden cozumlenir.

### 2.3. Arayuzler ve Yapisal Alt Tipleme (Structural Typing / Duck Typing)

Arayuzler (Interfaces), siniflar arasinda acik bir `implements` bildirimi olmasa dahi yapisal uyumlulugu destekler:

* **`itable` (Interface Table) ve Fat Pointer:** Bir nesne bir arayuz referansina atandiginda, derleyici iki isaretciden olusan bir fat pointer olusturur:
  1. Nesne ornegine isaret eden veri gostericisi (`data pointer`).
  2. Arayuz metodlarinin gercek adreslerini iceren sanal arayuz tablosu (`itable pointer`).

```typescript
interface Writer {
  write(data: string): i32;
}

class FileWriter {
  write(data: string): i32 {
    // yazma islemi
    return 1;
  }
}

function processOutput(w: Writer): void {
  w.write("veri");
}

let fw = new FileWriter();
processOutput(fw); // Yapisal alt tipleme ile otomatik fat pointer sarmalama
```

### 2.4. Tagged Unions ve Untagged Unions

* **Tagged Unions (Etiketli Birlikler):**
  Farkli tiplerin calisma zamaninda bir etiket (`discriminant`) ile ayirt edilmesini saglar. `typeof`, `instanceof` veya `in` operatorleri ile tip daraltma (type narrowing) uygulanir.

* **Untagged Unions (`Untagged<T>`):**
  C birligi (union) mantigiyla calisir. Tum alanlar bellek ofseti olarak sifirinci (0.) bayti paylasir. Hicbir etiket ya da ek yuk barindirmaz (type-punning icin uygundur).

```typescript
type HardwareRegister = Untagged<{
  asU32: u32;
  asBytes: u8[];
}>;
```

### 2.5. Jenerikler (Parametrik Cok Bicimlilik)

Siniflar, arayuzler ve fonksiyonlar generic tip parametreleri (`<T, U>`) kabul eder. Tip parametreleri semantik analiz sirasinda somut tiplerle eslenir.

---

## 3. Bellek Yonetimi ve Sahiplik Modeli

RypeScript, cop toplayici (garbage collector) calistirma maliyeti olmadan bellek guvenligi ve esnekligi saglamak amaciyla cok katmanli bir bellek yonetim modeli sunar.

### 3.1. Sahiplik ve Odunc Alma (Ownership & Borrowing)

* **`move(target)`:**
  Bir degiskenin tuttugu kaynagin sahipligini baska bir degiskene veya kapsama tasir. Tasinan kaynak artik eski degisken uzerinden erisilemez (`use-after-move` denetimi).

* **`borrow(target)`:**
  Kaynagin sahipligi devredilmeden, salt-okunur referans olarak fonksiyonlara aktarilmasini saglar.

```typescript
let buffer = malloc(1024);
let transferred = move(buffer);
// buffer artik kullanilamaz; transferred gecerlidir.
```

### 3.2. RAII ve Otomatik Temizlik (`using` Protokolu)

TypeScript'in `using` anahtar sozcugu ve `[Symbol.dispose]` arayuzu tam olarak desteklenir:

* Tanımlanan bloktan veya fonksiyondan cikildiginda (erken `return` dahil) `[Symbol.dispose]` yontemi deterministik olarak cagirilir.

```typescript
{
  using arena = new Arena(4096);
  let ptr = arena.alloc(64);
  // Kapsam sonlandiginda arena.dispose() otomatik calisir.
}
```

### 3.3. Bolgesel ve Ozel Bellek Yoneticileri (Allocators)

1. **`Arena` (Bump Allocator):**
   * Sirali, sifir parcalanmali bellek ayirici.
   * `alloc(sizeBytes: number): pointer`
   * `reset(): void`: Isaretciyi basa sararak tum tahsisatlari sifir maliyetle geri kazanir.
   * `dispose(): void`: Arenanin tuttugu ana bellek blogunu serbest birakir.

2. **`Pool` (Slab Allocator):**
   * Sabit boyutlu blok havuzu.
   * `alloc(): pointer`: Havuzdan bos bir blok alir.
   * `free(ptr: pointer): void`: Bloğu havuza iade eder.
   * `dispose(): void`: Tum havuzu serbest birakir.

3. **`FixedBuffer`:**
   * Sinirli, sabit kapasiteli deterministik tampon. Kapasite asiminda program sonlanir (trap).

### 3.4. Dusuk Seviyeli Bellek Intrinsics

C seviyesinde dogrudan bellek manipule etmek icin yerlesik fonksiyonlar mevcuttur:

* `malloc(sizeBytes: number): pointer`
* `free(ptr: pointer): void`
* `alloca(sizeBytes: number): pointer` (Yigin cercevesinde dinamik alan)
* `ptr_read_u8(ptr, offset?)`, `ptr_write_u8(ptr, offset, val)`
* `ptr_read_i32(ptr, offset?)`, `ptr_write_i32(ptr, offset, val)`
* `ptr_read_f64(ptr, offset?)`, `ptr_write_f64(ptr, offset, val)`
* `ptr_add(ptr, byteOffset): pointer`

---

## 4. Deterministik Hata Yonetimi

### 4.1. `Result<T, E>` Modeli

C-ABI duzeyinde calisan, sifir maliyetli basari/hata sarmalayicisidir:

* `Ok<T>(val: T): Result<T, E>`
* `Err<E>(err: E): Result<T, E>`
* `unwrap<T>(res: Result<T, E>): T`: Eger sonuc `Err` ise program `panic` ile sonlanir.

```typescript
function divide(a: f64, b: f64): Result<f64, string> {
  if (b === 0.0) {
    return Err("Sifira bolme hatasi");
  }
  return Ok(a / b);
}

let r = divide(10.0, 2.0);
if (r.ok) {
  let val = r.value;
}
```

### 4.2. Sav ve Panik

* **`panic(message?: string): never`:** Kurtarilamaz hata durumunda programi aninda LLVM abort/trap durumuna gecirir.
* **`assert(condition: boolean, message?: string)`:** Kosul `false` ise panik uretir.

### 4.3. Istisnalar (`try` / `catch` / `throw`)

Geleneksel istisna yonetimi kontrol akisi duzeyinde desteklenir.

---

## 5. Eszamanlilik ve Coklu Is Parcacigi (Concurrency)

### 5.1. Isletim Sistemi Is Parcaciklari (`spawn` / `join`)

POSIX pthread tabanli native is parcacigi baslatma ve bekleme:

* `spawn(worker, arg): ThreadHandle`
* `join(handle): void`

### 5.2. `Channel<T>` (Thread-Safe Kanal)

Is parcaciklari arasinda kilitli ve guvenli FIFO iletisimi:

* `constructor(capacity?: number)`: Bounded dairesel tampon.
* `send(value: T): void`: Kanala veri yazar (kanal doluysa bloklar).
* `recv(): T`: Kanaldan veri okur (kanal bossa bloklar).
* `close(): void`: Kanali kapatir ve bekleyen parcaciklari uyandirir.

### 5.3. Asenkron Programlama (`async` / `await` / `Promise<T>`)

* `async` anahtar sozcugu ile tanimlanan fonksiyonlar arka planda gorev olarak calisir.
* `await` ifadesi asenkron gorevin sonucunu bekler.

---

## 6. Donanim Hizlandirma ve SIMD (Vector Dialect)

RypeScript, MLIR Vector Dialect uzerinden 128-bit ve 256-bit SIMD tiplerini ve islevlerini dogrudan dilde birinci sinif eleman olarak destekler:

### 6.1. Desteklenen Vektor Tipleri

* `f32x4`: 4 adet 32-bit kayan noktali sayi (128-bit)
* `f64x2`: 2 adet 64-bit cift duyarlikli sayi (128-bit)
* `i32x4`: 4 adet 32-bit tamsayi (128-bit)
* `i64x2`: 2 adet 64-bit tamsayi (128-bit)

### 6.2. SIMD Islemleri

* **`splat(scalar)`:** Skaler bir degeri tum vektor seritlerine kopyalar.
* **`load(ptr)` / `store(ptr, vec)`:** Ham bellekten vektorel yukleme ve kaydetme.
* **Aritmetik:** `add`, `sub`, `mul`, `div`.
* **FMA:** `fma(a, b, c)` (Fused Multiply-Add: `a * b + c`).
* **Indirgeme (Reduction):** `reduce_add`, `reduce_mul`, `reduce_min`, `reduce_max`.
* **Serit Erisimi:** `extract(vec, idx)`, `insert(vec, idx, val)`.
* **Matematik:** `sqrt`, `abs`.

```typescript
let a = f32x4(1.0, 2.0, 3.0, 4.0);
let b = f32x4(5.0, 6.0, 7.0, 8.0);
let c = f32x4.add(a, b);
let top: f32 = f32x4.reduce_add(c);
```

---

## 7. C-FFI ve Harici Entegrasyonlar

### 7.1. C Baslik Dosyalarini Ice Aktarma

C `.h` dosyalari dogrudan modul gibi import edilebilir. Derleyici C fonksiyon prototiplerini ayristirir ve semantik analizore tanitir:

```typescript
import { puts, exit } from "./stdio.h";
```

### 7.2. Dinamik Kutuphane Baglama

`.so`, `.dll` veya `.dylib` dosyalari import edildiginde, LLD baglama asamasinda bu kutuphaneler otomatik olarak parametrelere eklenir:

```typescript
import "./libm.so";
```

### 7.3. Derleyici Dekoratorleri ve Pragmalari

* **`@inline`:** Fonksiyonu cagirildigi yere satir ici (alwaysinline) gomer.
* **`@noinline`:** Fonksiyonun satir icine gomulmesini engeller.
* **`@packed`:** Struct veya sinif alanlari arasindaki hizalama dolgusunu (padding) kaldirir.
* **`@export_name("c_sym")`:** Fonksiyonu belirtilen C sembol adiyla disariya aktarir.
* **`@napi`:** Fonksiyonu Node.js C++ eklentisi (N-API) olarak disa aktaran sarmalayici kod uretir.

---

## 8. Modul Sistemi

* ES Modul (`import` / `export`) sozluksel duzeni desteklenir.
* Dosya yollari `./` veya `../` ile belirtilir.
* Derleme sirasinda `ModuleResolver`, giris noktasindan baslayarak derinlemesine arama (DFS) ile bagimlilik grafigini cikarir ve topolojik sira ile AST listesini hazirlar.
