<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit(0);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'error' => 'Метод не поддерживается. Используйте POST.']);
    exit;
}

$rawInput = file_get_contents('php://input');
$input = json_decode($rawInput, true);

if (!$input || !is_array($input)) {
    echo json_encode(['success' => false, 'error' => 'Некорректный JSON']);
    exit;
}

if (!isset($input['name']) || !isset($input['data'])) {
    echo json_encode(['success' => false, 'error' => 'Отсутствуют обязательные параметры: name, data']);
    exit;
}

$fileName = $input['name'];
$base64Data = $input['data'];

if (strpos($fileName, '..') !== false) {
    echo json_encode(['success' => false, 'error' => 'Недопустимое имя файла']);
    exit;
}

if (empty($base64Data)) {
    echo json_encode(['success' => false, 'error' => 'Пустые данные файла']);
    exit;
}

$binaryData = base64_decode($base64Data, true);

if ($binaryData === false) {
    echo json_encode(['success' => false, 'error' => 'Ошибка декодирования base64']);
    exit;
}

$targetDir = dirname($fileName);
if ($targetDir !== '.' && $targetDir !== '') {
    if (!is_dir($targetDir)) {
        if (!mkdir($targetDir, 0755, true)) {
            echo json_encode(['success' => false, 'error' => 'Не удалось создать директорию: ' . $targetDir]);
            exit;
        }
    }
}

if (file_put_contents($fileName, $binaryData) === false) {
    echo json_encode(['success' => false, 'error' => 'Не удалось записать файл на сервер']);
    exit;
}

echo json_encode([
    'success' => true,
    'file' => $fileName,
    'size' => strlen($binaryData)
]);