// rypescript.d.ts
// RypeScript Sistem Dili - Standart Küresel Tip Deklarasyonları

declare global {
  // ==========================================
  // 1. DETERMINİSTİK HATA YÖNETİMİ (RESULT MODELİ)
  // ==========================================

  /**
   * C-ABI seviyesinde sıfır maliyetli (zero-cost) hata/değer sarmalayıcısı.
   * `T`: Başarı değeri tipi, `E`: Hata tipi (Varsayılan: string).
   */
  interface Result<T, E = string> {
    readonly ok: boolean;
    readonly value: T;
    readonly error: E;
  }

  /**
   * Başarılı bir Result nesnesi üretir (`ok = true`).
   * @param val Döndürülecek başarı değeri.
   */
  function Ok<T>(val: T): Result<T, never>;

  /**
   * Hatalı bir Result nesnesi üretir (`ok = false`).
   * @param err Hata mesajı veya hata nesnesi.
   */
  function Err<E = string>(err: E): Result<never, E>;

  /**
   * Result içindeki değeri döner.
   * Eğer Result hatalıysa (`ok = false`), program panic üreterek anında sonlanır (abort/trap).
   * @param res Çözümlenecek Result nesnesi.
   */
  function unwrap<T, E>(res: Result<T, E>): T;

  /**
   * Kurtarılamaz bir sistem hatasında programı anında panik durumuna geçirip sonlandırır (abort).
   * @param message Hata açıklaması.
   */
  function panic(message?: string): never;

  /**
   * Koşulun doğruluğunu denetler; koşul false ise programı abort eder.
   * @param condition Doğrulanacak boolean ifade.
   * @param message Başarısızlık durumunda ekrana basılacak mesaj.
   */
  function assert(condition: boolean, message?: string): asserts condition;

  // ==========================================
  // 2. SAHİPLİK VE ÖDÜNÇ ALMA (BORROW CHECKER)
  // ==========================================

  /**
   * Bir heap kaynağının sahipliğini devretmeden (move etmeden),
   * fonksiyonlara salt-okunur referans olarak ödünç verilmesini sağlar.
   * @param target Ödünç verilecek nesne veya kaynak.
   */
  function borrow<T>(target: T): T;

  // ==========================================
  // 3. EŞZAMANLILIK (CONCURRENCY: CHANNELS & THREADS)
  // ==========================================

  /**
   * Thread'ler arası FIFO kuyruğu ile veri taşıyan thread-safe kanal primitifi.
   * POSIX pthread_mutex ve pthread_cond tabanlıdır.
   */
  class Channel<T> {
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
     * Kanaldan değer okur. Kanal boşsa veri gelene kadar iş parçacığını kilitler.
     */
    recv(): T;
  }

  /**
   * Bir fonksiyonu arka planda bağımsız bir işletim sistemi iş parçacığında (OS pthread) başlatır.
   * @param worker Çalıştırılacak iş parçacığı fonksiyonu.
   * @param arg İş parçacığına aktarılacak argüman (örneğin Channel).
   * @returns İş parçacığı tanıtıcısı (Thread Handle).
   */
  function spawn<A>(worker: (arg: A) => void, arg: A): ThreadHandle;
  function spawn(worker: () => void): ThreadHandle;

  /**
   * Belirtilen iş parçacığının tamamlanmasını bekler (pthread_join) ve kaynağı serbest bırakır.
   * @param threadHandle spawn ile üretilen iş parçacığı tanıtıcısı.
   */
  function join(threadHandle: ThreadHandle): void;

  /**
   * OS seviyesinde bir iş parçacığı işaretçisini temsil eden opak tip.
   */
  type ThreadHandle = { readonly __brand: unique symbol };

  // ==========================================
  // 4. SİSTEM VE BELLEK TİPLERİ
  // ==========================================

  /**
   * C-Style saf bellek paylaşımı (type-punning) sağlayan untagged union tanımlayıcısı.
   * Tüm alanlar belleğin 0. ofsetini paylaşır.
   */
  type Untagged<T> = T;

  /**
   * Belirtilen milisaniye kadar işletim sistemi seviyesinde uyur (usleep).
   * @param ms Beklenecek süre (milisaniye).
   */
  function sleep(ms: number): void;

  // ==========================================
  // 5. ÇIPLAK VE ÖZEL BELLEK YÖNETİCİLERİ
  // ==========================================

  /** İşletim sisteminden çıplak heap belleği ayırır (C malloc). */
  function malloc(sizeBytes: number): any;

  /** Daha önce malloc ile ayrılmış bir bellek bloğunu serbest bırakır (C free). */
  function free(ptr: any): void;

  /** Geçerli fonksiyonun stack çerçevesinde (stack frame) dinamik bayt ayırır. */
  function alloca(sizeBytes: number): any;

  /**
   * Zig tarzı bölgesel Bump Allocator.
   * İşaretçi sadece ileri kayar; reset() ile sıfırlanır veya using ile toptan yok edilir.
   */
  class Arena {
    constructor(capacityBytes?: number);
    alloc(sizeBytes: number): any;
    reset(): void;
    dispose(): void;
    [Symbol.dispose](): void;
  }

  /**
   * Sabit boyutlu blok havuzu (Slab/Pool Allocator).
   * Tekil blokları free() ile havuza geri kabul eder, sıfır bellek parçalanması sağlar.
   */
  class Pool {
    constructor(chunkSizeBytes: number, chunkCount?: number);
    alloc(): any;
    free(ptr: any): void;
    dispose(): void;
    [Symbol.dispose](): void;
  }

  /**
   * Bounded deterministik tampon bellek yöneticisi.
   * Sabit kapasiteyi aşarsa trap/abort eder.
   */
  class FixedBuffer {
    constructor(capacityBytes: number);
    alloc(sizeBytes: number): any;
    reset(): void;
    dispose(): void;
    [Symbol.dispose](): void;
  }

  // ==========================================
  // 6. DERLEYİCİ DECORATOR'LARI (PRAGMAS)
  // ==========================================

  /** Fonksiyon veya metot çağrısını satır içine (inline) kopyalayarak çağrı maliyetini sıfırlar (LLVM alwaysinline). */
  function inline(...args: any[]): any;

  /** Fonksiyon veya metodun satır içine gömülmesini kesinlikle engeller (LLVM noinline). */
  function noinline(...args: any[]): any;

  /** C-Style struct veya sınıfta alanlar arası 8-bayt hizalama dolgusunu (padding) kaldırarak bayt bayt sıkıştırır. */
  function packed(...args: any[]): any;

  /** Fonksiyonun dışarıya aktarılacak saf C sembol adını belirler (C-ABI export alias). */
  function export_name(name: string): (...args: any[]) => any;
}

export {};