// std/stringbuilder.ts
// RypeScript Standart Kütüphanesi - Yüksek Performanslı Metin İnşa Edici (StringBuilder)

export class StringBuilder {
  ptr: pointer;
  capacity: number;
  length: number;

  constructor(initialCapacity?: number) {
    let cap = initialCapacity;
    if (cap <= 0) {
      cap = 64;
    }
    this.capacity = cap;
    this.length = 0;
    this.ptr = malloc(cap);
  }

  ensureCapacity(needed: number): void {
    if (this.length + needed >= this.capacity) {
      let newCap = this.capacity * 2;
      if (newCap < this.length + needed + 16) {
        newCap = this.length + needed + 16;
      }
      let newPtr: pointer = malloc(newCap);
      for (let i = 0; i < this.length; i++) {
        let b = ptr_read_u8(this.ptr, i);
        ptr_write_u8(newPtr, i, b);
      }
      free(this.ptr);
      this.ptr = newPtr;
      this.capacity = newCap;
    }
  }

  append(text: string): StringBuilder {
    let strLen: number = text.length;
    if (strLen == 0) {
      return this;
    }
    this.ensureCapacity(strLen);
    let curLen = this.length;
    let textPtr = text as pointer;
    for (let i = 0; i < strLen; i++) {
      let b = ptr_read_u8(textPtr, i);
      ptr_write_u8(this.ptr, curLen + i, b);
    }
    this.length = curLen + strLen;
    return this;
  }

  appendChar(charCode: number): StringBuilder {
    this.ensureCapacity(1);
    ptr_write_u8(this.ptr, this.length, charCode);
    this.length = this.length + 1;
    return this;
  }

  appendLine(text?: string): StringBuilder {
    if (text !== null) {
      this.append(text);
    }
    this.appendChar(10);
    return this;
  }

  appendInt(val: number): StringBuilder {
    if (val == 0) {
      this.appendChar(48);
      return this;
    }
    let n = val;
    if (val < 0) {
      this.appendChar(45);
      n = 0 - val;
    }

    let tempBuf: pointer = malloc(32);
    let count: number = 0;
    while (n > 0) {
      let rem: number = n % 10;
      ptr_write_u8(tempBuf, count, rem + 48);
      n = (n - rem) / 10;
      count = count + 1;
    }

    for (let i = count - 1; i >= 0; i--) {
      let b = ptr_read_u8(tempBuf, i);
      this.appendChar(b);
    }
    free(tempBuf);
    return this;
  }

  clear(): void {
    this.length = 0;
  }

  toString(): string {
    let len = this.length;
    let strBuf: pointer = malloc(len + 1);
    for (let i = 0; i < len; i++) {
      let b = ptr_read_u8(this.ptr, i);
      ptr_write_u8(strBuf, i, b);
    }
    ptr_write_u8(strBuf, len, 0);
    return strBuf as string;
  }

  dispose(): void {
    if (this.ptr !== null) {
      free(this.ptr);
      this.ptr = null;
    }
  }
}
