/**
 * Trình tạo Snowflake ID.
 * Cấu trúc (64 bit) trả về dưới dạng string:
 * - 41 bits: Timestamp (mili-giây) từ một epoch cố định.
 * - 10 bits: Machine/Worker ID (0 - 1023).
 * - 12 bits: Sequence number (0 - 4095).
 */
export class SnowflakeGenerator {
  private readonly EPOCH = 1704067200000n; // 2024-01-01T00:00:00.000Z
  private readonly MACHINE_ID_BITS = 10n;
  private readonly SEQUENCE_BITS = 12n;

  private readonly MAX_MACHINE_ID = -1n ^ (-1n << this.MACHINE_ID_BITS);
  private readonly MAX_SEQUENCE = -1n ^ (-1n << this.SEQUENCE_BITS);

  private readonly MACHINE_ID_SHIFT = this.SEQUENCE_BITS;
  private readonly TIMESTAMP_SHIFT = this.SEQUENCE_BITS + this.MACHINE_ID_BITS;

  private machineId: bigint;
  private sequence: bigint = 0n;
  private lastTimestamp: bigint = -1n;

  constructor(machineId?: number) {
    let id = machineId;
    if (id === undefined) {
      // Đọc từ biến môi trường, mặc định là 1 nếu không có
      id = parseInt(process.env.PROCESS_ID || '1', 10);
    }

    this.machineId = BigInt(id);
    if (this.machineId < 0n || this.machineId > this.MAX_MACHINE_ID) {
      throw new Error(
        `Machine ID phải nằm trong khoảng từ 0 đến ${this.MAX_MACHINE_ID}`,
      );
    }
  }

  private currentTimestamp(): bigint {
    return BigInt(Date.now());
  }

  private waitNextMillis(currentTimestamp: bigint): bigint {
    let timestamp = this.currentTimestamp();
    while (timestamp <= currentTimestamp) {
      timestamp = this.currentTimestamp();
    }
    return timestamp;
  }

  public nextId(): string {
    let timestamp = this.currentTimestamp();

    if (timestamp < this.lastTimestamp) {
      throw new Error('Đồng hồ hệ thống bị lùi lại. Không thể sinh ID.');
    }

    if (timestamp === this.lastTimestamp) {
      this.sequence = (this.sequence + 1n) & this.MAX_SEQUENCE;
      if (this.sequence === 0n) {
        // Hết sequence trong 1 mili-giây, đợi sang mili-giây tiếp theo
        timestamp = this.waitNextMillis(this.lastTimestamp);
      }
    } else {
      this.sequence = 0n;
    }

    this.lastTimestamp = timestamp;

    const id =
      ((timestamp - this.EPOCH) << this.TIMESTAMP_SHIFT) |
      (this.machineId << this.MACHINE_ID_SHIFT) |
      this.sequence;

    return id.toString();
  }
}

// Khởi tạo Singleton để dùng chung toàn app
export const snowflake = new SnowflakeGenerator();
