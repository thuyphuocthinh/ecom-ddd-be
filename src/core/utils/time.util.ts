import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export class TimeUtil {
  static getCurrentUtc(): string {
    return dayjs().utc().toISOString();
  }

  static addMinutes(minutes: number, fromDate?: string | Date): string {
    const base = fromDate ? dayjs(fromDate) : dayjs();
    return base.add(minutes, 'minute').utc().toISOString();
  }

  static isExpired(targetDate: string | Date): boolean {
    return dayjs().isAfter(dayjs(targetDate));
  }

  static toUtcDate(dateString: string): Date {
    return dayjs(dateString).utc().toDate();
  }
}
