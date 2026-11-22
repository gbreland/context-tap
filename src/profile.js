import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function run(argv) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (src, res) => {
                try {
                    const [, stdout] = src.communicate_utf8_finish(res);
                    resolve({text: stdout ?? '', ok: src.get_successful()});
                } catch {
                    resolve({text: '', ok: false});
                }
            });
        } catch {
            resolve({text: '', ok: false});
        }
    });
}

function capLines(text, max = 60) {
    const lines = String(text ?? '').replace(/\s+$/, '').split('\n').filter((line, index, all) => line !== '' || index < all.length - 1);
    const body = lines.join('\n').trim();
    if (!body)
        return '';
    if (lines.length <= max)
        return body;
    return `${lines.slice(0, max).join('\n')}\n... ${lines.length - max} more lines`;
}

function checkFailed(result) {
    const text = String(result?.text ?? '').trim();
    return !result?.ok || !text || text.startsWith('Skipped');
}

const GPU_CHECK = [
    'if command -v lspci >/dev/null 2>&1 && command -v grep >/dev/null 2>&1; then',
    "    lspci -nnk | grep -A3 -Ei 'VGA|3D|Display'",
    'else',
    "    printf 'Skipped GPU check: lspci or grep is not installed.\\n'",
    'fi',
].join('\n');

const SESSION_CHECK = 'printf \'Session: %s\\nDesktop: %s\\n\' "${XDG_SESSION_TYPE:-unknown}" "${XDG_CURRENT_DESKTOP:-unknown}"';

const GLX_CHECK = [
    'if command -v glxinfo >/dev/null 2>&1; then',
    '    glxinfo -B',
    'else',
    "    printf 'Skipped renderer check: glxinfo is not installed.\\n'",
    'fi',
].join('\n');

const POWER_CHECK = [
    'if command -v powerprofilesctl >/dev/null 2>&1; then',
    '    powerprofilesctl get',
    'else',
    "    printf 'Skipped power profile check: powerprofilesctl is not installed.\\n'",
    'fi',
].join('\n');

const DRM_CHECK = [
    'found=0',
    'for card in /sys/class/drm/card[0-9]*; do',
    '    [ -e "$card/device/driver" ] || continue',
    '    found=1',
    '    driver=$(basename "$(readlink -f "$card/device/driver")")',
    '    vendor=$(cat "$card/device/vendor" 2>/dev/null)',
    '    device=$(cat "$card/device/device" 2>/dev/null)',
    '    printf \'%s vendor=%s device=%s driver=%s\\n\' "$(basename "$card")" "$vendor" "$device" "$driver"',
    'done',
    'if [ "$found" -eq 0 ]; then',
    "    printf 'No DRM card driver was found.\\n'",
    'fi',
    "lsmod | grep -Ei '^(nvidia|nouveau|amdgpu|i915|xe|radeon) ' || true",
].join('\n');

const EGL_CHECK = [
    'if command -v eglinfo >/dev/null 2>&1; then',
    '    eglinfo -B',
    'else',
    "    printf 'Skipped EGL check: eglinfo is not installed.\\n'",
    'fi',
].join('\n');

const PROFILE_CHECK = [
    'if [ -r /sys/firmware/acpi/platform_profile ]; then',
    '    printf \'platform_profile=%s\\n\' "$(cat /sys/firmware/acpi/platform_profile)"',
    'else',
    "    printf 'No platform_profile file was found.\\n'",
    'fi',
].join('\n');

const CPU_CHECK = [
    'if command -v lscpu >/dev/null 2>&1; then',
    '    lscpu',
    'else',
    "    printf 'Skipped CPU check: lscpu is not installed.\\n'",
    'fi',
].join('\n');

const CPU_FILE_CHECK = [
    'model=$(awk -F: \'/model name/ {gsub(/^[ \\t]+/, "", $2); print $2; exit}\' /proc/cpuinfo)',
    'count=$(grep -c \'^processor\' /proc/cpuinfo)',
    'printf \'model name: %s\\nprocessors: %s\\n\' "${model:-unknown}" "$count"',
].join('\n');

const MEMORY_CHECK = [
    'ok=0',
    'if command -v free >/dev/null 2>&1; then',
    '    free -h',
    '    ok=1',
    'else',
    "    printf 'Skipped memory check: free is not installed.\\n'",
    'fi',
    'if command -v swapon >/dev/null 2>&1; then',
    '    swapon --show',
    '    ok=1',
    'else',
    "    printf 'Skipped swap check: swapon is not installed.\\n'",
    'fi',
    '[ "$ok" -eq 1 ]',
].join('\n');

const MEMORY_FILE_CHECK = 'awk \'/MemTotal|MemAvailable|SwapTotal|SwapFree/ {print}\' /proc/meminfo';

const KERNEL_CHECK = [
    'if ! command -v journalctl >/dev/null 2>&1; then',
    "    printf 'Skipped kernel log check: journalctl is not installed.\\n'",
    '    exit 0',
    'fi',
    'if ! journalctl -b -k -n 1 --no-pager >/dev/null 2>&1; then',
    "    printf 'Skipped kernel log check: journalctl could not read this boot.\\n'",
    '    exit 1',
    'fi',
    "hits=$(journalctl -b -k --no-pager | grep -Ei 'nouveau|drm|gpu|firmware|fault|timeout' || true)",
    'if [ -n "$hits" ]; then',
    "    printf '%s\\n' \"$hits\" | tail -n 60",
    'else',
    "    printf 'No matching kernel graphics lines.\\n'",
    'fi',
].join('\n');

const DMESG_CHECK = [
    'if ! command -v dmesg >/dev/null 2>&1; then',
    "    printf 'Skipped kernel log check: dmesg is not installed.\\n'",
    '    exit 0',
    'fi',
    "hits=$(dmesg 2>&1 | grep -Ei 'nouveau|drm|gpu|firmware|fault|timeout' || true)",
    'if [ -n "$hits" ]; then',
    "    printf '%s\\n' \"$hits\" | tail -n 60",
    'else',
    "    printf 'No matching kernel graphics lines in dmesg.\\n'",
    'fi',
].join('\n');

const PACKAGE_CHECK = [
    'if ! command -v rpm >/dev/null 2>&1; then',
    "    printf 'Skipped package check: rpm is not installed.\\n'",
    '    exit 0',
    'fi',
    "hits=$(rpm -qa | grep -Ei 'mesa|nouveau|nvidia|vulkan|linux-firmware' || true)",
    'if [ -n "$hits" ]; then',
    "    printf '%s\\n' \"$hits\" | sort",
    'else',
    "    printf 'No matching graphics packages.\\n'",
    'fi',
].join('\n');

const BOOT_CHECK = [
    'if command -v mokutil >/dev/null 2>&1; then',
    '    mokutil --sb-state 2>&1',
    'else',
    "    printf 'Skipped Secure Boot check: mokutil is not installed.\\n'",
    'fi',
].join('\n');

const EFI_CHECK = [
    'if [ -d /sys/firmware/efi ]; then',
    "    printf 'EFI system. Secure Boot state was not read.\\n'",
    'else',
    "    printf 'Not an EFI system.\\n'",
    'fi',
].join('\n');

async function runShell(script) {
    return run(['timeout', '8', 'bash', '-c', script]);
}

export function graphicsText(parts) {
    const lines = ['Graphics drivers:'];
    const add = (title, result, failedTitle, max = 60) => {
        lines.push(title);
        lines.push(capLines(result?.text, max) || failedTitle);
    };
    add('# GPU hardware and active kernel drivers', parts.gpu, 'GPU check failed.');
    add('# Session type and desktop', parts.session, 'Session check failed.');
    add('# Renderer', parts.glx, 'Renderer check failed.');
    add('# Power profile', parts.power, 'Power profile check failed.');
    if (checkFailed(parts.gpu))
        add('# DRM devices, because the GPU check did not run', parts.drm, 'DRM check failed.');
    if (checkFailed(parts.glx))
        add('# EGL, because the renderer check did not run', parts.egl, 'EGL check failed.');
    if (checkFailed(parts.power))
        add('# Platform profile, because the power check did not run', parts.profile, 'Platform profile check failed.');
    add('# CPU model and topology', parts.cpu, 'CPU check failed.');
    if (checkFailed(parts.cpu))
        add('# CPU from /proc/cpuinfo, because lscpu did not run', parts.cpuFile, 'CPU file check failed.');
    add('# System memory and swap', parts.memory, 'Memory check failed.');
    if (checkFailed(parts.memory))
        add('# Memory from /proc/meminfo, because free did not run', parts.memoryFile, 'Memory file check failed.');
    add('# Kernel graphics lines from this boot', parts.kernel, 'Kernel log check failed.');
    if (checkFailed(parts.kernel))
        add('# Kernel graphics lines from dmesg, because journalctl did not run', parts.dmesg, 'dmesg check failed.');
    add('# Installed graphics packages', parts.packages, 'Package check failed.', 120);
    add('# Secure Boot', parts.secureBoot, 'Secure Boot check failed.');
    if (checkFailed(parts.secureBoot))
        add('# Firmware type, because mokutil did not run', parts.efi, 'Firmware check failed.');
    return lines.join('\n');
}

export async function graphicsReport() {
    const [gpu, session, glx, power, cpu, memory, kernel, packages, secureBoot] = await Promise.all([
        runShell(GPU_CHECK),
        runShell(SESSION_CHECK),
        runShell(GLX_CHECK),
        runShell(POWER_CHECK),
        runShell(CPU_CHECK),
        runShell(MEMORY_CHECK),
        runShell(KERNEL_CHECK),
        runShell(PACKAGE_CHECK),
        runShell(BOOT_CHECK),
    ]);
    const extra = await Promise.all([
        checkFailed(gpu) ? runShell(DRM_CHECK) : Promise.resolve(null),
        checkFailed(glx) ? runShell(EGL_CHECK) : Promise.resolve(null),
        checkFailed(power) ? runShell(PROFILE_CHECK) : Promise.resolve(null),
        checkFailed(cpu) ? runShell(CPU_FILE_CHECK) : Promise.resolve(null),
        checkFailed(memory) ? runShell(MEMORY_FILE_CHECK) : Promise.resolve(null),
        checkFailed(kernel) ? runShell(DMESG_CHECK) : Promise.resolve(null),
        checkFailed(secureBoot) ? runShell(EFI_CHECK) : Promise.resolve(null),
    ]);
    return graphicsText({
        gpu, session, glx, power, cpu, memory, kernel, packages, secureBoot,
        drm: extra[0], egl: extra[1], profile: extra[2],
        cpuFile: extra[3], memoryFile: extra[4], dmesg: extra[5], efi: extra[6],
    });
}

function readFile(path) {
    try {
        const [, bytes] = Gio.File.new_for_path(path).load_contents(null);
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

const STANDING_FILE = 'standing.txt';
const OLD_POLICY = 'You can read application context. You cannot directly control apps or send anything to them automatically. A command or action can be suggested to the user and they will be able to click on the action to send it to the application.';

function dataDir() {
    const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'context-tap']);
    GLib.mkdir_with_parents(dir, 0o700);
    return dir;
}

export function policyText() {
    return 'Give only the next step, then wait. Do not give a full lecture or the later steps. You can read application context. You cannot directly control apps or send anything to them automatically. A command or action can be suggested to the user and they will be able to click on the action to send it to the application.';
}

export function standingFrom(text) {
    const raw = String(text ?? '');
    const trimmed = raw.trim();
    if (!trimmed || trimmed === OLD_POLICY)
        return policyText();
    return raw;
}

export function loadStanding() {
    try {
        const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), STANDING_FILE]));
        const [, bytes] = file.load_contents(null);
        return standingFrom(new TextDecoder().decode(bytes));
    } catch {
        /* The default text is used until the user edits it. */
    }
    return policyText();
}

export function saveStanding(text) {
    const file = Gio.File.new_for_path(GLib.build_filenamev([dataDir(), STANDING_FILE]));
    const stream = file.replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
    stream.write_bytes(GLib.Bytes.new(new TextEncoder().encode(text)), null);
    stream.close(null);
}

export async function hostProfile() {
    const osRelease = readFile('/etc/os-release');
    const [kernelRun, archRun, rpmRun, packageRun, graphics] = await Promise.all([
        run(['uname', '-srm']),
        run(['uname', '-m']),
        run(['rpm', '-qa', '--last']),
        run(['dnf', 'repoquery', '--userinstalled', '--qf', '%{name}']),
        graphicsReport().catch(() => 'Graphics drivers:\nGraphics check failed.'),
    ]);
    const kernel = kernelRun.text.trim();
    const arch = archRun.text.trim();
    const lastRpm = rpmRun.text.split('\n').find(line => line.trim()) ?? '';
    const names = packageRun.text.split('\n').map(line => line.trim()).filter(Boolean);
    const capped = names.length > 400;
    return {
        host: [
            osRelease.trim(),
            `Kernel: ${kernel}`,
            `Architecture: ${arch}`,
            `Last rpm transaction: ${lastRpm}`,
        ].join('\n'),
        packages: names.slice(0, 400).join('\n'),
        packageCount: names.length,
        capped,
        graphics,
    };
}

export function profilePath() {
    return GLib.get_user_data_dir();
}
