
import type { MenuSchedule } from "@/lib/types";

const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Checks if a given menu schedule is active at the current moment.
 * @param schedule The schedule object to check.
 * @param now A Date object for the current time (optional, for testing).
 * @returns `true` if the schedule is active, `false` otherwise.
 */
export function isScheduleActiveNow(schedule: MenuSchedule, now = new Date()): boolean {
    if (!schedule.isActive) {
        return false;
    }

    const currentDayName = daysOfWeek[now.getDay()];
    // If no days are specified, assume it's active every day (if the schedule itself is active).
    if (schedule.days && schedule.days.length > 0 && !schedule.days.includes(currentDayName)) {
        return false;
    }

    // Safe fallback for missing times: treat as active all day if day matches.
    if (!schedule.startTime || !schedule.endTime || !schedule.startTime.includes(':') || !schedule.endTime.includes(':')) {
        return true;
    }

    const [startHour, startMinute] = schedule.startTime.split(':').map(Number);
    const [endHour, endMinute] = schedule.endTime.split(':').map(Number);

    // Additional safe fallback for parsing errors
    if (isNaN(startHour) || isNaN(startMinute) || isNaN(endHour) || isNaN(endMinute)) {
        return true;
    }
    
    const currentTimeInMinutes = now.getHours() * 60 + now.getMinutes();
    const startTimeInMinutes = startHour * 60 + startMinute;
    const endTimeInMinutes = endHour * 60 + endMinute;

    if (startTimeInMinutes <= endTimeInMinutes) {
        // Same-day window (e.g., 09:00 to 22:00)
        return currentTimeInMinutes >= startTimeInMinutes && currentTimeInMinutes < endTimeInMinutes;
    } else {
        // Overnight window (e.g., 18:00 to 02:00)
        return currentTimeInMinutes >= startTimeInMinutes || currentTimeInMinutes < endTimeInMinutes;
    }
}
