import { hostname } from 'os';
import { createHash } from 'crypto';

/**
 * Derives a machine id from the host's hostname when PROCESS_ID isn't set
 * explicitly, so different containers/instances don't silently collide on
 * the same default id (each container gets a distinct hostname in
 * Docker/Kubernetes, unlike a fixed literal default).
 */
function deriveMachineIdFromHostname(maxMachineId: number): number {
  const hash = createHash('sha256').update(hostname()).digest();
  const value = hash.readUInt32BE(0);
  return value % (maxMachineId + 1);
}

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
      // PROCESS_ID lets an operator pin an explicit id (e.g. from a k8s
      // pod ordinal). Without it, every instance would otherwise fall back
      // to the same hardcoded default and risk generating colliding ids —
      // so instead each host derives its own id from its hostname.
      id = process.env.PROCESS_ID
        ? parseInt(process.env.PROCESS_ID, 10)
        : deriveMachineIdFromHostname(Number(this.MAX_MACHINE_ID));
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
