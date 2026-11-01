<?php
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');
header('Cache-Control: no-cache, no-store, must-revalidate');
header('Pragma: no-cache');
header('Expires: 0');

$dir = __DIR__;

if (!is_readable($dir)) {
    http_response_code(500);
    echo json_encode(['error' => 'Directory not readable: ' . $dir]);
    exit;
}

$files = [];
$exclude = ['ostatok.xlsx'];

if ($handle = opendir($dir)) {
    while (false !== ($entry = readdir($handle))) {
        if ($entry === '.' || $entry === '..') continue;

        $filePath = $dir . '/' . $entry;

        if (!is_file($filePath)) continue;
        if (!is_readable($filePath)) continue;

        $ext = strtolower(pathinfo($entry, PATHINFO_EXTENSION));
        if ($ext !== 'xlsx') continue;

        if (in_array(strtolower($entry), array_map('strtolower', $exclude), true)) continue;

        $files[] = [
            'name' => $entry,
            'size' => filesize($filePath),
            'lastModified' => filemtime($filePath)
        ];
    }
    closedir($handle);
} else {
    http_response_code(500);
    echo json_encode(['error' => 'Cannot open directory: ' . $dir]);
    exit;
}

usort($files, function($a, $b) {
    return $b['lastModified'] - $a['lastModified'];
});

echo json_encode($files, JSON_UNESCAPED_UNICODE);
?>