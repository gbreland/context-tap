import {allowFrom, decide, decision, splitFresh} from '../src/context.js';
import {graphicsText, policyText, standingFrom} from '../src/profile.js';

const allow = {host: 'ask', packages: 'ask', terminal: {}, screenshot: {}};
if (decision(allow, 'host') !== 'ask')
    throw new Error('host starts as ask');
decide(allow, 'host', null, 'allow');
if (decision(allow, 'host') !== 'allow')
    throw new Error('host allow failed');
decide(allow, 'packages', null, 'deny');
if (decision(allow, 'packages') !== 'deny')
    throw new Error('packages deny failed');
const freshTerminal = {host: 'ask', packages: 'ask', terminal: {}, screenshot: {}};
if (decision(freshTerminal, 'terminal', 'org.gnome.Ptyxis.Devel') !== 'allow')
    throw new Error('terminal defaults to allow');
decide(allow, 'terminal', 'org.gnome.Ptyxis.Devel', 'deny');
if (decision(allow, 'terminal', 'org.gnome.Ptyxis.Devel') !== 'deny')
    throw new Error('terminal deny failed');
if (decision(allow, 'screenshot', 'org.gnome.Firefox') !== 'ask')
    throw new Error('missing screenshot must stay ask');
const loaded = allowFrom({host: 'allow', packages: 'deny'});
if (loaded.graphics !== 'allow')
    throw new Error('graphics defaults to allow');
if (allowFrom(null).host !== 'allow')
    throw new Error('host defaults to allow');
if (allowFrom({host: 'ask'}).host !== 'allow')
    throw new Error('host ask becomes allow');
if (allowFrom({host: 'deny'}).host !== 'deny')
    throw new Error('host deny failed');
if (allowFrom({graphics: 'deny'}).graphics !== 'deny')
    throw new Error('graphics deny failed');
const gpu = {text: 'VGA NVIDIA', ok: true};
const skipped = {text: 'Skipped renderer check: glxinfo is not installed.', ok: true};
const report = graphicsText({
    gpu,
    session: {text: 'Session: wayland\nDesktop: GNOME', ok: true},
    glx: skipped,
    power: {text: 'balanced', ok: true},
    egl: {text: 'Skipped EGL check: eglinfo is not installed.', ok: true},
});
if (!report.includes('VGA NVIDIA') || !report.includes('balanced'))
    throw new Error(`graphics report lost a result: ${report}`);
if (!report.includes('# EGL'))
    throw new Error('a failed renderer check must add EGL context');
if (report.includes('# DRM'))
    throw new Error('a successful GPU check must not add DRM context');
const failedGpu = graphicsText({
    gpu: {text: 'Skipped GPU check: lspci or grep is not installed.', ok: true},
    session: {text: 'Session: wayland', ok: true},
    glx: gpu,
    power: {text: '', ok: false},
    drm: {text: 'card1 driver=nvidia', ok: true},
    profile: {text: 'platform_profile=balanced', ok: true},
});
if (!failedGpu.includes('card1 driver=nvidia') || !failedGpu.includes('platform_profile=balanced'))
    throw new Error(`fallback context missing: ${failedGpu}`);
const extra = graphicsText({
    gpu,
    session: {text: 'Session: wayland', ok: true},
    glx: gpu,
    power: {text: 'balanced', ok: true},
    cpu: {text: 'Model name: AMD Ryzen', ok: true},
    memory: {text: 'Mem: 32Gi', ok: true},
    kernel: {text: 'No matching kernel graphics lines.', ok: true},
    packages: {text: 'mesa-dri-drivers', ok: true},
    secureBoot: {text: 'SecureBoot enabled', ok: true},
});
if (!extra.includes('Model name: AMD Ryzen') || !extra.includes('Mem: 32Gi'))
    throw new Error(`system context missing: ${extra}`);
if (!extra.includes('mesa-dri-drivers') || !extra.includes('SecureBoot enabled'))
    throw new Error(`graphics package context missing: ${extra}`);
if (extra.includes('dmesg') || extra.includes('/proc/cpuinfo') || extra.includes('Firmware type'))
    throw new Error('successful checks must not add fallbacks');
const noMok = graphicsText({
    gpu, session: {text: 'Session: wayland', ok: true}, glx: gpu, power: {text: 'balanced', ok: true},
    secureBoot: {text: 'Skipped Secure Boot check: mokutil is not installed.', ok: true},
    efi: {text: 'EFI system. Secure Boot state was not read.', ok: true},
});
if (!noMok.includes('Secure Boot state was not read'))
    throw new Error(`mokutil fallback missing: ${noMok}`);

const same = splitFresh('abc', 'abc');
if (same.changed || same.fresh)
    throw new Error('same text must not look new');
const tail = splitFresh('hello\n', 'hello\nnext');
if (tail.sent !== 'hello\n' || tail.fresh !== 'next')
    throw new Error(`tail split failed: ${JSON.stringify(tail)}`);
const slid = splitFresh(`xxxx${'old-'.repeat(20)}END`, `${'old-'.repeat(20)}END\nNEW`);
if (!slid.fresh.endsWith('NEW') || !slid.sent.includes('END'))
    throw new Error(`slide split failed: ${JSON.stringify(slid)}`);
if (!policyText().includes('cannot directly control apps'))
    throw new Error('standing text lost the control rule');
if (!policyText().includes('next step'))
    throw new Error('standing text lost the next-step rule');
const oldPolicy = 'You can read application context. You cannot directly control apps or send anything to them automatically. A command or action can be suggested to the user and they will be able to click on the action to send it to the application.';
if (standingFrom(oldPolicy) !== policyText())
    throw new Error('old default was kept');
if (standingFrom('Keep this note.') !== 'Keep this note.')
    throw new Error('edited standing text changed');
print('context tests passed');
