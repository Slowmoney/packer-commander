'use strict';

const path = require('node:path');

const {
    TuiApp,
    assertTerminal,
    selfCheck,
    findProjectRoot,
    workspaceRoots,
    readJsonFile,
} = require('./task-runner.js');

const USAGE = `packer-commander — TUI-раннер npm-скриптов монорепозитория.

Использование:
  packer-commander [опции]

Опции:
  --cwd <путь>     откуда искать корень проекта (по умолчанию текущая папка)
  --roots a,b      папки воркспейсов вручную вместо чтения "workspaces"
  --self-check     напечатать найденный корень, папки и число пакетов, не поднимая TUI
  -v, --version    версия
  -h, --help       эта справка

Горячие клавиши — внутри, по "?".
GitLab-пайплайны включаются, если в окружении есть GITLAB_TOKEN (scope read_api,
для запуска пайплайнов — api).
`;

function parseArgs(argv) {
    const options = { cwd: process.cwd(), roots: null, selfCheck: false, help: false, version: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--version' || arg === '-v') {
            options.version = true;
        } else if (arg === '--self-check') {
            options.selfCheck = true;
        } else if (arg === '--cwd') {
            index += 1;
            options.cwd = argv[index] ?? process.cwd();
        } else if (arg === '--roots') {
            index += 1;
            options.roots = String(argv[index] ?? '')
                .split(',')
                .map((part) => part.trim())
                .filter((part) => part.length > 0);
        } else {
            options.unknown = arg;
        }
    }
    return options;
}

function version() {
    return readJsonFile(path.join(__dirname, '..', 'package.json'))?.version ?? '0.0.0';
}

function main(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
    const options = parseArgs(argv);

    if (options.help) {
        stdout.write(USAGE);
        return { code: 0, running: false };
    }
    if (options.version) {
        stdout.write(`${version()}\n`);
        return { code: 0, running: false };
    }
    if (options.unknown) {
        stderr.write(`Неизвестная опция: ${options.unknown}\n\n${USAGE}`);
        return { code: 2, running: false };
    }

    const repoRoot = findProjectRoot(options.cwd);
    const roots = options.roots ?? workspaceRoots(repoRoot);

    if (options.selfCheck) {
        return { code: selfCheck({ repoRoot, roots, stdout }), running: false };
    }

    try {
        assertTerminal({ stdout });
    } catch (error) {
        stderr.write(`${error.message}\n`);
        return { code: 1, running: false };
    }

    new TuiApp({ repoRoot, roots }).run();
    // TUI живёт на event loop и завершает процесс сам по "q".
    return { code: 0, running: true };
}

module.exports = { main, parseArgs, USAGE };
