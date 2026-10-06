// rypescript.d.ts
// RypeScript Sistem Programlama Dili - Kapsamlı Standart Tip Deklarasyonları (Ambient Declarations)
// IDE (VS Code, WebStorm, Neovim vb.) dil sunucusu için tam entegrasyon ve sıfır-hata desteği sağlar.

declare global {
  // ==========================================
  // 1. SKALER VE SİSTEM TİP TANIMLARI (PRIMITIVES)
  // ==========================================

  /** 8-bit işaretli tamsayı (LLVM i8). Aralık: -128 .. 127 */
  type i8 = number;

  /** 8-bit işaretsiz tamsayı (LLVM i8). Aralık: 0 .. 255 */
  type u8 = number;

  /** 8-bit işaretsiz bayt (LLVM i8). Aralık: 0 .. 255 */
  type byte = number;

  /** 32-bit işaretli tamsayı (LLVM i32). Aralık: -2,147,483,648 .. 2,147,483,647 */
  type i32 = number;

  /** 64-bit işaretli tamsayı (LLVM i64). Aralık: -9,223,372,036,854,775,808 .. 9,223,372,036,854,775,807 */
  type i64 = number;

  /** 32-bit işaretsiz tamsayı (LLVM i32). Aralık: 0 .. 4,294,967,295 */
  type u32 = number;

  /** 64-bit işaretsiz tamsayı (LLVM i64). Aralık: 0 .. 18,446,744,073,709,551,615 */
  type u64 = number;

  /** 32-bit tek duyarlıklı kayan noktalı sayı (LLVM f32 / IEEE 754 float) */
  type f32 = number;

  /** 64-bit çift duyarlıklı kayan noktalı sayı (LLVM f64 / IEEE 754 double) */
  type f64 = number;

  /** 1-bit mantıksal doğruluk değeri (LLVM i1 / boolean) */
  type bool = boolean;

  /** 32-bit işaretli tamsayı takma adı (C `int` uyumlu) */
  type int = number;

  /** 32-bit kayan nokta takma adı (C `float` uyumlu) */
  type float = number;

  /** 64-bit kayan nokta takma adı (C `double` uyumlu) */
  type double = number;

  /** 8-bit işaretsiz bayt (LLVM i8) */
  type byte = number;

  /** Platform mimarisine bağlı işaretçi boyutunda işaretsiz tamsayı (x86_64 için 64-bit, wasm32 için 32-bit) */
  type usize = number;

  /** Platform mimarisine bağlı işaretçi boyutunda işaretli tamsayı */
  type isize = number;

  /**
   * Çıplak C / LLVM seviyesi bellek işaretçisi (!llvm.ptr).
   * Null, undefined, nesne veya sayısal adresleri tutabilir.
   */
  type pointer = any;

  /** Çıplak işaretçi takma adı (pointer) */
  type ptr = pointer;

  /**
   * C-Style saf bellek paylaşımı (type-punning / C union) sağlayan untagged union tanımlayıcısı.
   * Tüm alanlar belleğin 0. ofsetini paylaşır, ek yük (discriminant) taşımaz.
   */
  type Untagged<T> = T;

  // ==========================================
  // 2. DETERMINİSTİK HATA YÖNETİMİ (RESULT & PANIC MODELİ)
  // ==========================================

  /**
   * C-ABI seviyesinde sıfır maliyetli (zero-cost) hata/değer sarmalayıcısı.
   * `T`: Başarı değeri tipi, `E`: Hata tipi (Varsayılan: string).
   */
  interface Result<T, E = string> {
    /** İşlemin başarı durumunu belirtir (`true` ise başarılı, `false` ise hatalı). */
    readonly ok: boolean;
    /** İşlem başarılıysa (`ok === true`) üretilen sonuç değeri; aksi halde tanımsızdır. */
    readonly value: T;
    /** İşlem başarısızsa (`ok === false`) dönen hata mesajı veya nesnesi; aksi halde tanımsızdır. */
    readonly error: E;
  }

  /**
   * Başarılı bir Result nesnesi üretir (`ok = true`).
   * @param val Başarı değeri.
   */
  function Ok<T, E = never>(val: T): Result<T, E>;

  /**
   * Hatalı bir Result nesnesi üretir (`ok = false`).
   * @param err Hata mesajı veya nesnesi.
   */
  function Err<E = string, T = never>(err: E): Result<T, E>;

  /**
   * Result içindeki değeri çözer (unwrap).
   * Eğer Result hatalıysa (`ok === false`), program anında panik üreterek sonlanır (LLVM abort/trap).
   * @param res Çözümlenecek Result nesnesi.
   */
  function unwrap<T, E = any>(res: Result<T, E>): T;

  /**
   * Kurtarılamaz bir sistem hatasında programı anında panik durumuna geçirip sonlandırır (abort).
   * @param message Hata açıklaması.
   */
  function panic(message?: string): never;

  /**
   * Çalışma zamanı koşul denetimi yapar; koşul false ise programı abort eder.
   * TypeScript asserts mekanizması ile tam uyumludur.
   * @param condition Doğrulanacak boolean ifade.
   * @param message Başarısızlık durumunda ekrana basılacak mesaj.
   */
  function assert(condition: boolean, message?: string): asserts condition;

  // ==========================================
  // 3. SAHİPLİK VE ÖDÜNÇ ALMA (OWNERSHIP & BORROW CHECKER)
  // ==========================================

  /**
   * Bir heap kaynağının sahipliğini devretmeden (move etmeden),
   * fonksiyonlara salt-okunur referans olarak ödünç verilmesini sağlar.
   * @param target Ödünç verilecek nesne veya kaynak.
   */
  function borrow<T>(target: T): T;

  /**
   * Bir kaynağın sahipliğini açıkça (explicit) yeni bir değişkene veya kapsama taşır.
   * Kaynak taşındıktan sonra eski değişken artık kullanılamaz (use-after-move derleme hatası).
   * @param target Taşınacak nesne veya kaynak.
   */
  function move<T>(target: T): T;

  // ==========================================
  // 4. EŞZAMANLILIK (CONCURRENCY: CHANNELS & THREADS)
  // ==========================================

  /**
   * Thread'ler arası FIFO kuyruğu ile veri taşıyan thread-safe kanal primitifi.
   * POSIX pthread_mutex ve pthread_cond tabanlı sıfır-kopyalama (zero-copy) mimarisine sahiptir.
   */
  class Channel<T = any> {
    /**
     * Belirtilen kapasitede dairesel tamponlu (bounded buffer) kanal oluşturur.
     * @param capacity Kanal kapasitesi (Varsayılan: 1).
     */
    constructor(capacity?: number);

    /**
     * Kanala değer gönderir. Kanal doluysa yer açılana kadar iş parçacığını kilitler.
     * @param value Gönderilecek değer.
     */
    send(value: T): void;

    /**
     * Kanaldan değer okur. Kanal boşsa veri gelene kadar çağıran iş parçacığını kilitler.
     */
    recv(): T;

    /** Kanalı kapatır ve bekleyen tüm iş parçacıklarını uyandırır. */
    close(): void;
  }

  /**
   * OS seviyesinde bir iş parçacığı veya asenkron görev tanıtıcısı (Thread Handle).
   */
  type ThreadHandle = any;

  /**
   * Bir fonksiyonu arka planda bağımsız bir işletim sistemi iş parçacığında (OS pthread) başlatır.
   * @param worker Çalıştırılacak iş parçacığı fonksiyonu.
   * @param arg İş parçacığına aktarılacak argüman (örneğin Channel veya veri yapısı).
   * @returns İş parçacığı tanıtıcısı (ThreadHandle).
   */
  function spawn<A>(worker: (arg: A) => void, arg: A): ThreadHandle;
  function spawn(worker: () => void): ThreadHandle;
  function spawn<T, A extends any[]>(worker: (...args: A) => T, ...args: A): ThreadHandle;

  /**
   * Belirtilen iş parçacığının veya asenkron görevin tamamlanmasını bekler (pthread_join / task join) ve kaynakları temizler.
   * @param threadHandle spawn ile üretilen iş parçacığı veya async fonksiyondan dönen task handle'ı.
   */
  function join(threadHandle: ThreadHandle | Promise<any> | pointer): void;

  // ==========================================
  // 5. ÇIPLAK VE ÖZEL BELLEK YÖNETİCİLERİ (ALLOCATORS & RAII)
  // ==========================================

  /**
   * İşletim sisteminden belirtilen bayt kadar ham heap belleği ayırır (C malloc).
   * @param sizeBytes Ayrılacak bellek boyutu (bayt).
   * @returns Ham bellek işaretçisi.
   */
  function malloc(sizeBytes: number): pointer;

  /**
   * Daha önce malloc ile ayrılmış bir bellek bloğunu serbest bırakır (C free).
   * @param ptr Serbest bırakılacak bellek işaretçisi.
   */
  function free(ptr: pointer): void;

  /**
   * Geçerli fonksiyonun yığın çerçevesinde (stack frame) dinamik bayt ayırır.
   * Fonksiyondan çıkıldığında otomatik olarak sıfır maliyetle geri kazanılır.
   * @param sizeBytes Ayrılacak yığın boyutu (bayt).
   */
  function alloca(sizeBytes: number): pointer;

  /** Ham bellek işaretçisinden belirtilen bayt ofsetinden 1 bayt (u8 / i8) okur. */
  function ptr_read_u8(ptr: pointer, offset?: number): number;

  /** Ham bellek işaretçisinde belirtilen bayt ofsetine 1 bayt (u8 / i8) yazar. */
  function ptr_write_u8(ptr: pointer, offset: number, value: number): void;

  /** Ham bellek işaretçisinden belirtilen bayt ofsetinden 32-bit tamsayı (i32) okur. */
  function ptr_read_i32(ptr: pointer, offset?: number): number;

  /** Ham bellek işaretçisinde belirtilen bayt ofsetine 32-bit tamsayı (i32) yazar. */
  function ptr_write_i32(ptr: pointer, offset: number, value: number): void;

  /** Ham bellek işaretçisinden belirtilen bayt ofsetinden 64-bit float (f64) okur. */
  function ptr_read_f64(ptr: pointer, offset?: number): number;

  /** Ham bellek işaretçisinde belirtilen bayt ofsetine 64-bit float (f64) yazar. */
  function ptr_write_f64(ptr: pointer, offset: number, value: number): void;

  /** İşaretçiye bayt cinsinden ofset ekleyerek yeni bir işaretçi döndürür (pointer arithmetic). */
  function ptr_add(ptr: pointer, byteOffset: number): pointer;

  /**
   * Zig/Rust tarzı bölgesel Bump Allocator.
   * İşaretçi sadece ileri kayar; reset() ile sıfırlanır veya `using` ile toptan yok edilir (RAII).
   */
  class Arena {
    /**
     * Belirtilen bayt kapasitesinde Arena tahsis eder.
     * @param capacityBytes Arena boyutu (Varsayılan: 1024).
     */
    constructor(capacityBytes?: number);

    /** Arena içinden belirtilen bayt kadar bellek dilimi ayırır. */
    alloc(sizeBytes: number): pointer;

    /** Arena işaretçisini en başa sararak belleği sıfır maliyetle yeniden kullanıma açar. */
    reset(): void;

    /** Arena'yı serbest bırakır ve tüm tahsisatları geçersiz kılar. */
    dispose(): void;

    /** TypeScript `using` anahtar sözcüğü ile RAII otomatik temizlik desteği. */
    [Symbol.dispose](): void;
  }

  /**
   * Sabit boyutlu blok havuzu (Slab/Pool Allocator).
   * Tekil blokları free() ile havuza geri kabul eder, sıfır bellek parçalanması sağlar.
   */
  class Pool {
    /**
     * Sabit boyutlu bloklardan oluşan bir havuz tahsis eder.
     * @param chunkSizeBytes Her bir bloğun boyutu (bayt).
     * @param chunkCount Havuzdaki toplam blok adedi (Varsayılan: 1024).
     */
    constructor(chunkSizeBytes: number, chunkCount?: number);

    /** Havuzdan boşta duran tek bir blok ayırır. */
    alloc(): pointer;

    /** Daha önce havuzdan alınmış bir bloğu havuza geri iade eder. */
    free(ptr: pointer): void;

    /** Havuzu ve barındırdığı tüm bellek sayfalarını tamamen serbest bırakır. */
    dispose(): void;

    /** TypeScript `using` anahtar sözcüğü ile RAII otomatik temizlik desteği. */
    [Symbol.dispose](): void;
  }

  /**
   * Bounded deterministik tampon bellek yöneticisi.
   * Sabit kapasiteyi aşarsa trap/abort eder.
   */
  class FixedBuffer {
    /**
     * Belirtilen kapasitede sabit bir bellek tamponu tahsis eder.
     * @param capacityBytes Tampon kapasitesi (bayt).
     */
    constructor(capacityBytes: number);

    /** Tampon içinden yer ayırır. */
    alloc(sizeBytes: number): pointer;

    /** Tampon ofsetini sıfırlar. */
    reset(): void;

    /** Tamponu tamamen serbest bırakır. */
    dispose(): void;

    /** TypeScript `using` anahtar sözcüğü ile RAII otomatik temizlik desteği. */
    [Symbol.dispose](): void;
  }

  // ==========================================
  // 6. SİSTEM VE ZAMAN YARDIMCILARI
  // ==========================================

  /**
   * Belirtilen milisaniye kadar işletim sistemi seviyesinde uyur (POSIX usleep / Windows Sleep).
   * @param ms Beklenecek süre (milisaniye).
   */
  function sleep(ms: number): void;

  /**
   * Süreci belirtilen çıkış koduyla derhal sonlandırır.
   * @param code Süreç çıkış kodu (Varsayılan: 0).
   */
  function exit(code?: number): never;

  namespace process {
    /**
     * Süreci belirtilen çıkış koduyla derhal sonlandırır.
     * @param code Süreç çıkış kodu (Varsayılan: 0).
     */
    function exit(code?: number): never;

    /**
     * Komut satırı argümanları listesi.
     */
    const argv: string[];

    /**
     * Komut satırı argüman sayısı.
     */
    const argc: number;
  }

  // ==========================================
  // 6.1. METİN VE KARAKTER İŞLEMLERİ (STRINGS)
  // ==========================================

  interface String {
    /** C-string null-terminated karakter sayısı (bayt uzunluğu). */
    readonly length: number;
    /** Sıfır kopyalı alt-dize dilimi üretir. */
    slice(start?: number, end?: number): string;
    /** Sıfır kopyalı alt-dize dilimi üretir. */
    substring(start?: number, end?: number): string;
    /** Belirtilen indeksteki karakterin ASCII/UTF-8 sayısal kodunu (i32) sıfır maliyetle okur. */
    charCodeAt(index?: number): number;
  }

  interface StringConstructor {
    /** Verilen ASCII/UTF-8 karakter kodundan 1 baytlık null-terminated C-string üretir. */
    fromCharCode(code: number): string;
  }

  const String: StringConstructor;

  // ==========================================
  // 7. DERLEYİCİ DEKORATÖRLERİ VE PRAGMALAR
  // ==========================================

  type RypePragma = any;

  /**
   * Fonksiyon veya metot çağrısını satır içine (inline) kopyalayarak çağrı maliyetini sıfırlar (LLVM alwaysinline).
   */
  function inline(...args: any[]): RypePragma;

  /**
   * Fonksiyon veya metodun satır içine gömülmesini kesinlikle engeller (LLVM noinline).
   */
  function noinline(...args: any[]): RypePragma;

  /**
   * C-Style struct, sınıf veya arayüzde alanlar arası hizalama dolgusunu (padding) kaldırarak bayt bayt sıkıştırır.
   */
  function packed(...args: any[]): RypePragma;

  /**
   * Fonksiyonun dışarıya aktarılacak saf C sembol adını belirler (C-ABI export alias).
   * @param name Dışa aktarılacak saf C sembol adı (örn: `"rype_native_entry"`).
   */
  function export_name(name: string): (...args: any[]) => RypePragma;

  /**
   * Fonksiyonu doğrudan Node.js eklentisi (.node) olarak dışa aktaran N-API köprüsü üretir.
   */
  function napi(...args: any[]): RypePragma;

  /**
   * Benzersiz tek sahiplik (unique pointer) özniteliği.
   */
  function unique(...args: any[]): RypePragma;

  // ==========================================
  // 9. SIMD VEKTÖR TİPLERİ VE DONANIM HIZLANDIRMA (VECTOR DIALECT)
  // ==========================================

  interface f32x4 {
    readonly [index: number]: number;
  }
  namespace f32x4 {
    function splat(v: number): f32x4;
    function load(ptr: pointer): f32x4;
    function store(ptr: pointer, val: f32x4): void;
    function add(a: f32x4, b: f32x4): f32x4;
    function sub(a: f32x4, b: f32x4): f32x4;
    function mul(a: f32x4, b: f32x4): f32x4;
    function div(a: f32x4, b: f32x4): f32x4;
    function fma(a: f32x4, b: f32x4, c: f32x4): f32x4;
    function reduce_add(a: f32x4): number;
    function reduce_mul(a: f32x4): number;
    function reduce_min(a: f32x4): number;
    function reduce_max(a: f32x4): number;
    function extract(a: f32x4, idx: number): number;
    function insert(a: f32x4, idx: number, val: number): f32x4;
    function sqrt(a: f32x4): f32x4;
    function abs(a: f32x4): f32x4;
  }
  function f32x4(x?: number, y?: number, z?: number, w?: number): f32x4;

  interface f64x2 {
    readonly [index: number]: number;
  }
  namespace f64x2 {
    function splat(v: number): f64x2;
    function load(ptr: pointer): f64x2;
    function store(ptr: pointer, val: f64x2): void;
    function add(a: f64x2, b: f64x2): f64x2;
    function sub(a: f64x2, b: f64x2): f64x2;
    function mul(a: f64x2, b: f64x2): f64x2;
    function div(a: f64x2, b: f64x2): f64x2;
    function fma(a: f64x2, b: f64x2, c: f64x2): f64x2;
    function reduce_add(a: f64x2): number;
    function reduce_mul(a: f64x2): number;
    function reduce_min(a: f64x2): number;
    function reduce_max(a: f64x2): number;
    function extract(a: f64x2, idx: number): number;
    function insert(a: f64x2, idx: number, val: number): f64x2;
    function sqrt(a: f64x2): f64x2;
    function abs(a: f64x2): f64x2;
  }
  function f64x2(x?: number, y?: number): f64x2;

  interface i32x4 {
    readonly [index: number]: number;
  }
  namespace i32x4 {
    function splat(v: number): i32x4;
    function load(ptr: pointer): i32x4;
    function store(ptr: pointer, val: i32x4): void;
    function add(a: i32x4, b: i32x4): i32x4;
    function sub(a: i32x4, b: i32x4): i32x4;
    function mul(a: i32x4, b: i32x4): i32x4;
    function reduce_add(a: i32x4): number;
    function reduce_min(a: i32x4): number;
    function reduce_max(a: i32x4): number;
    function extract(a: i32x4, idx: number): number;
    function insert(a: i32x4, idx: number, val: number): i32x4;
  }
  function i32x4(x?: number, y?: number, z?: number, w?: number): i32x4;

  interface i64x2 {
    readonly [index: number]: number;
  }
  namespace i64x2 {
    function splat(v: number): i64x2;
    function load(ptr: pointer): i64x2;
    function store(ptr: pointer, val: i64x2): void;
    function add(a: i64x2, b: i64x2): i64x2;
    function sub(a: i64x2, b: i64x2): i64x2;
    function mul(a: i64x2, b: i64x2): i64x2;
    function reduce_add(a: i64x2): number;
    function extract(a: i64x2, idx: number): number;
    function insert(a: i64x2, idx: number, val: number): i64x2;
  }
  function i64x2(x?: number, y?: number): i64x2;

  namespace simd {
    function f32x4(x?: number, y?: number, z?: number, w?: number): f32x4;
    function f64x2(x?: number, y?: number): f64x2;
    function i32x4(x?: number, y?: number, z?: number, w?: number): i32x4;
    function i64x2(x?: number, y?: number): i64x2;
    function splat_f32x4(v: number): f32x4;
    function splat_f64x2(v: number): f64x2;
    function splat_i32x4(v: number): i32x4;
    function splat_i64x2(v: number): i64x2;
    function load_f32x4(ptr: pointer): f32x4;
    function load_f64x2(ptr: pointer): f64x2;
    function load_i32x4(ptr: pointer): i32x4;
    function store(ptr: pointer, val: any): void;
    function add<T>(a: T, b: T): T;
    function sub<T>(a: T, b: T): T;
    function mul<T>(a: T, b: T): T;
    function div<T>(a: T, b: T): T;
    function fma<T>(a: T, b: T, c: T): T;
    function reduce_add(a: any): number;
    function sum(a: any): number;
    function reduce_mul(a: any): number;
    function reduce_min(a: any): number;
    function reduce_max(a: any): number;
    function extract(a: any, idx: number): number;
    function insert<T>(a: T, idx: number, val: number): T;
    function sqrt<T>(a: T): T;
    function abs<T>(a: T): T;
  }
}

// ==========================================
// 8. C / NATIVE VE İKİLİ DOSYA MODÜL DEKLARASYONLARI
// ==========================================

/** C başlık dosyaları (.h) doğrudan içe aktarılabilir. */
declare module "*.h";
declare module "*libmath.h" {
  export const rts_add: (a: number, b: number) => number;
  export const rts_multiply: (a: number, b: number) => number;
}

/** Linux ELF dinamik kütüphaneleri (.so) doğrudan içe aktarılabilir. */
declare module "*.so";
declare module "*libmath.so";

/** Windows dinamik kütüphaneleri (.dll) doğrudan içe aktarılabilir. */
declare module "*.dll";

/** macOS dinamik kütüphaneleri (.dylib) doğrudan içe aktarılabilir. */
declare module "*.dylib";

/** Node.js native eklentileri (.node) doğrudan içe aktarılabilir. */
declare module "*.node";

/** WebAssembly modülleri (.wasm) doğrudan içe aktarılabilir. */
declare module "*.wasm";

export {};