import {ageLabel, elapsedLabel} from '../src/age.js';

const cases = [
    [0, 'Seconds ago'],
    [4, 'Seconds ago'],
    [5, '5 seconds ago'],
    [59, '59 seconds ago'],
    [60, '1 minute ago'],
    [119, '1 minute ago'],
    [120, '2 minutes ago'],
    [3599, '59 minutes ago'],
    [3600, '1 hour ago'],
    [7200, '2 hours ago'],
    [86399, '23 hours ago'],
    [86400, '1 day ago'],
    [172800, '2 days ago'],
    [6 * 86400, '6 days ago'],
    [7 * 86400, '1 week ago'],
    [14 * 86400, '2 weeks ago'],
    [29 * 86400, '4 weeks ago'],
    [30 * 86400, '1 month ago'],
    [60 * 86400, '2 months ago'],
    [364 * 86400, '12 months ago'],
    [365 * 86400, '1 year ago'],
    [730 * 86400, '2 years ago'],
];

for (const [seconds, text] of cases) {
    const got = ageLabel(seconds);
    if (got !== text)
        throw new Error(`${seconds}s: expected ${text}, got ${got}`);
}

if (elapsedLabel(400) !== '1 second')
    throw new Error(elapsedLabel(400));
if (elapsedLabel(12000) !== '12 seconds')
    throw new Error(elapsedLabel(12000));
if (elapsedLabel(64000) !== '1 minute 4 seconds')
    throw new Error(elapsedLabel(64000));

print('age tests passed');
