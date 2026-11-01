<?php
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: GET, POST, OPTIONS");
header("Access-Control-Allow-Headers: Content-Type, Authorization, Accept, Accept-Language");
header("Content-Type: application/json");

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit();
}

$perco_host = "http://srv-perco1";
$target_url = isset($_GET['url']) ? $_GET['url'] : '';

if (empty($target_url)) {
    http_response_code(400);
    echo json_encode(["error" => "Missing url parameter"]);
    exit();
}

$target_url = ltrim($target_url, '/');
$url = $perco_host . '/' . $target_url;

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);

$headers = [];
foreach (getallheaders() as $name => $value) {
    $lower_name = strtolower($name);
    if ($lower_name !== 'host' && $lower_name !== 'content-length') {
        $headers[] = "$name: $value";
    }
}
$headers[] = "Host: srv-perco1";
curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents('php://input'));
}

$response = curl_exec($ch);
$http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curl_error = curl_error($ch);
$curl_errno = curl_errno($ch);
curl_close($ch);

if ($curl_errno) {
    http_response_code(502);
    echo json_encode([
        "error" => "Proxy connection failed",
        "curl_error" => $curl_error,
        "target_url" => $url,
        "note" => "Сервер srv-perco1 недоступен из интернета. Запустите этот скрипт локально."
    ]);
} else {
    http_response_code($http_code);
    echo $response;
}
?>