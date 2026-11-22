export function elapsedLabel(ms) {
    const seconds = Math.max(1, Math.round(Number(ms) / 1000));
    if (seconds < 60)
        return seconds === 1 ? '1 second' : `${seconds} seconds`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    const minuteText = minutes === 1 ? '1 minute' : `${minutes} minutes`;
    if (!rest)
        return minuteText;
    const secondText = rest === 1 ? '1 second' : `${rest} seconds`;
    return `${minuteText} ${secondText}`;
}

export function ageLabel(ageSeconds) {
    const age = Math.max(0, Math.floor(ageSeconds));
    if (age < 5)
        return 'Seconds ago';
    if (age < 60)
        return `${age} seconds ago`;
    const minutes = Math.floor(age / 60);
    if (minutes < 60)
        return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
    const hours = Math.floor(age / 3600);
    if (hours < 24)
        return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
    const days = Math.floor(age / 86400);
    if (days < 7)
        return days === 1 ? '1 day ago' : `${days} days ago`;
    if (days < 30) {
        const weeks = Math.floor(days / 7);
        return weeks === 1 ? '1 week ago' : `${weeks} weeks ago`;
    }
    if (days < 365) {
        const months = Math.floor(days / 30);
        return months === 1 ? '1 month ago' : `${months} months ago`;
    }
    const years = Math.floor(days / 365);
    return years === 1 ? '1 year ago' : `${years} years ago`;
}
