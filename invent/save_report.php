<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Method not allowed']);
    exit;
}

$raw = file_get_contents('php://input');
$input = json_decode($raw, true);

if (!$input || !isset($input['name']) || !isset($input['data'])) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Invalid data']);
    exit;
}

$fileName = $input['name'];

if (strpos($fileName, '/') !== false || strpos($fileName, '\\') !== false) {
    $parts = explode('/', str_replace('\\', '/', $fileName));
    $fileName = end($parts);
}

if (!preg_match('/^[a-zA-Z0-9_\-\.~]+$/', $fileName)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Invalid filename characters: ' . $fileName]);
    exit;
}

$targetDir = __DIR__;

if (!is_writable($targetDir)) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'Directory not writable: ' . $targetDir]);
    exit;
}

$filePath = $targetDir . DIRECTORY_SEPARATOR . $fileName;

try {
    $data = base64_decode($input['data'], true);
    if ($data === false) {
        throw new Exception('Invalid base64 data');
    }

    if (strlen($data) === 0) {
        throw new Exception('Empty file data');
    }

    $result = file_put_contents($filePath, $data);

    if ($result === false) {
        throw new Exception('Failed to write file');
    }

    echo json_encode([
        'success' => true,
        'filename' => $fileName,
        'size' => $result
    ]);
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => $e->getMessage()]);
}
?>