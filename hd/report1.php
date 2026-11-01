<?php
// report.php — единая точка доступа к problem.xlsx
//   GET  → {success, exists, version, data(base64)}
//   POST {base, data} → записывает файл, только если base == текущая версия (иначе 409 + conflict)
// Версия = md5 содержимого файла ('none', если файла ещё нет).

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

define('REPORT_FILE', __DIR__ . '/problem.xlsx');
define('PREV_FILE',   __DIR__ . '/problem.prev.xlsx');
define('LOCK_FILE',   __DIR__ . '/problem.lock');
define('MAX_BYTES',   30 * 1024 * 1024);

function respond($status, $payload) {
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

$lock = @fopen(LOCK_FILE, 'c');
if (!$lock) {
    respond(500, ['success' => false, 'error' => 'Не удалось создать problem.lock (проверьте права на запись в папке)']);
}

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    flock($lock, LOCK_SH);
    if (!is_file(REPORT_FILE)) {
        respond(200, ['success' => true, 'exists' => false, 'version' => 'none']);
    }
    $bin = file_get_contents(REPORT_FILE);
    if ($bin === false) {
        respond(500, ['success' => false, 'error' => 'Не удалось прочитать problem.xlsx']);
    }
    respond(200, ['success' => true, 'exists' => true, 'version' => md5($bin), 'data' => base64_encode($bin)]);
}

if ($method !== 'POST') {
    respond(405, ['success' => false, 'error' => 'Метод не поддерживается']);
}

$req = json_decode(file_get_contents('php://input'), true);
if (!is_array($req) || !isset($req['data']) || !isset($req['base'])) {
    respond(400, ['success' => false, 'error' => 'Неверный запрос']);
}

$bin = base64_decode($req['data'], true);
if ($bin === false || strlen($bin) < 100 || substr($bin, 0, 2) !== 'PK') {
    respond(400, ['success' => false, 'error' => 'Данные не похожи на xlsx-файл']);
}
if (strlen($bin) > MAX_BYTES) {
    respond(413, ['success' => false, 'error' => 'Файл слишком большой']);
}

// Критическая секция: проверка версии + запись под эксклюзивной блокировкой
flock($lock, LOCK_EX);

$current = is_file(REPORT_FILE) ? md5_file(REPORT_FILE) : 'none';
if ((string)$req['base'] !== $current) {
    respond(409, ['success' => false, 'conflict' => true, 'version' => $current]);
}

if (is_file(REPORT_FILE)) {
    @copy(REPORT_FILE, PREV_FILE); // страховочная копия предыдущей версии
}

$tmp = REPORT_FILE . '.tmp' . getmypid();
if (file_put_contents($tmp, $bin) === false) {
    @unlink($tmp);
    respond(500, ['success' => false, 'error' => 'Не удалось записать временный файл (права на запись?)']);
}
if (md5_file($tmp) !== md5($bin)) {
    @unlink($tmp);
    respond(500, ['success' => false, 'error' => 'Контрольная сумма записанного файла не совпала']);
}
if (!@rename($tmp, REPORT_FILE)) {
    @unlink(REPORT_FILE); // на Windows-хостингах rename поверх существующего может не сработать
    if (!@rename($tmp, REPORT_FILE)) {
        @unlink($tmp);
        respond(500, ['success' => false, 'error' => 'Не удалось заменить problem.xlsx']);
    }
}

respond(200, ['success' => true, 'version' => md5($bin)]);