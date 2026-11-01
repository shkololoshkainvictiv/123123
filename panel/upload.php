<?php
header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Неверный метод запроса']);
    exit;
}

$type = $_POST['type'] ?? '';

if (!isset($_FILES['file']) || $_FILES['file']['error'] !== UPLOAD_ERR_OK) {
    echo json_encode(['success' => false, 'message' => 'Ошибка загрузки файла на сервер']);
    exit;
}

$file = $_FILES['file'];
$ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
$allowedExts = ['xlsx', 'xls', 'csv', 'ods'];

if (!in_array($ext, $allowedExts)) {
    echo json_encode(['success' => false, 'message' => 'Разрешены только форматы: xlsx, xls, csv, ods']);
    exit;
}

$baseDir = dirname(__DIR__);
$fileName = ($type === 'ostatok' ? 'ostatok' : 'tabel') . '.' . $ext;

function ensureDir($dir) {
    if (!is_dir($dir)) {
        if (!mkdir($dir, 0755, true)) {
            return false;
        }
    }
    return true;
}

function safeWriteFile($source, $destination) {
    if (file_exists($destination)) {
        chmod($destination, 0644);
        if (!unlink($destination)) {
            return false;
        }
    }
    if (!copy($source, $destination)) {
        return false;
    }
    chmod($destination, 0644);
    return true;
}

if ($type === 'ostatok') {
    $dirs = [
        $baseDir . '/invent',
        $baseDir . '/zapolnenie',
        $baseDir . '/zapolnenie1',
        $baseDir . '/pros4et'
    ];

    foreach ($dirs as $dir) {
        if (!ensureDir($dir)) {
            echo json_encode(['success' => false, 'message' => 'Не удалось создать директорию: ' . basename($dir)]);
            exit;
        }
    }

    $tmpFile = $file['tmp_name'];
    $firstTarget = $dirs[0] . '/' . $fileName;

    if (file_exists($firstTarget)) {
        chmod($firstTarget, 0644);
        unlink($firstTarget);
    }

    if (!move_uploaded_file($tmpFile, $firstTarget)) {
        echo json_encode(['success' => false, 'message' => 'Не удалось сохранить файл в папку invent']);
        exit;
    }

    chmod($firstTarget, 0644);

    $errors = [];

    if (!safeWriteFile($firstTarget, $dirs[1] . '/' . $fileName)) {
        $errors[] = 'zapolnenie';
    }

    if (!safeWriteFile($firstTarget, $dirs[2] . '/' . $fileName)) {
        $errors[] = 'zapolnenie1';
    }

    if (!safeWriteFile($firstTarget, $dirs[3] . '/' . $fileName)) {
        $errors[] = 'pros4et';
    }

    if (empty($errors)) {
        echo json_encode(['success' => true, 'message' => 'Остатки перезаписаны в 4 директориях']);
    } else {
        echo json_encode(['success' => false, 'message' => 'Ошибка перезаписи в: ' . implode(', ', $errors)]);
    }

} elseif ($type === 'tabel') {
    $dirs = [
        $baseDir . '/tabel',
        $baseDir . '/tabel1'
    ];

    foreach ($dirs as $dir) {
        if (!ensureDir($dir)) {
            echo json_encode(['success' => false, 'message' => 'Не удалось создать директорию: ' . basename($dir)]);
            exit;
        }
    }

    $tmpFile = $file['tmp_name'];
    $firstTarget = $dirs[0] . '/' . $fileName;

    if (file_exists($firstTarget)) {
        chmod($firstTarget, 0644);
        unlink($firstTarget);
    }

    if (!move_uploaded_file($tmpFile, $firstTarget)) {
        echo json_encode(['success' => false, 'message' => 'Не удалось сохранить файл в папку tabel']);
        exit;
    }

    chmod($firstTarget, 0644);

    if (safeWriteFile($firstTarget, $dirs[1] . '/' . $fileName)) {
        echo json_encode(['success' => true, 'message' => 'Табель перезаписан в 2 директориях']);
    } else {
        echo json_encode(['success' => false, 'message' => 'Ошибка перезаписи в папку tabel1']);
    }

} else {
    echo json_encode(['success' => false, 'message' => 'Неверный тип файла']);
}
?>