<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$files = [];
$dir = __DIR__;

if ($handle = opendir($dir)) {
    while (false !== ($entry = readdir($handle))) {
        if ($entry !== '.' && $entry !== '..' && pathinfo($entry, PATHINFO_EXTENSION) === 'xlsx') {
            $filePath = $dir . '/' . $entry;
            $files[] = [
                'name' => $entry,
                'size' => filesize($filePath),
                'lastModified' => filemtime($filePath)
            ];
        }
    }
    closedir($handle);
}

usort($files, function($a, $b) {
    return $b['lastModified'] - $a['lastModified'];
});

echo json_encode($files);
?>