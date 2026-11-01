<?php
session_start();
header('Content-Type: application/json');

$action = $_GET['action'] ?? '';
$input = json_decode(file_get_contents('php://input'), true);

$API_BASE = 'https://multon-goods-ru.utrace.cloud/api/stock';
$AUTH_URL = 'https://multon-goods-ru.utrace.cloud/auth/api/auth?locale=ru-RU';

// Универсальная функция для cURL запросов
function makeRequest($url, $method = 'GET', $headers = [], $body = null) {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
    
    $curlHeaders = [];
    foreach ($headers as $key => $value) {
        $curlHeaders[] = "$key: $value";
    }
    curl_setopt($ch, CURLOPT_HTTPHEADER, $curlHeaders);
    
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, is_string($body) ? $body : json_encode($body));
    }
    
    $result = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    
    return ['code' => $httpCode, 'body' => $result];
}

// Функция получения токена с кэшированием в сессии
function getToken() {
    global $AUTH_URL;
    if (!empty($_SESSION['utrace_token'])) {
        return $_SESSION['utrace_token'];
    }
    
    $headers = [
        'accept' => 'application/json',
        'content-type' => 'application/json'
    ];
    $body = json_encode(['login' => 'RF120267', 'password' => '123456MIX']);
    
    $res = makeRequest($AUTH_URL, 'POST', $headers, $body);
    
    if ($res['code'] >= 200 && $res['code'] < 300) {
        $data = json_decode($res['body'], true);
        $token = $data['token'] ?? $data['access_token'] ?? $res['body'];
        $_SESSION['utrace_token'] = $token;
        return $token;
    }
    throw new Exception("Auth Failed: " . $res['code']);
}

try {
    if ($action === 'reserve') {
        $token = getToken();
        $headers = ['accept' => 'application/json', 'content-type' => 'application/json', 'authorization' => $token];
        
        $body = [
            'gtin' => $input['gtin'],
            'productionSite' => '3942',
            'count' => (int)$input['count']
        ];
        
        $res = makeRequest("$API_BASE/reserve", 'POST', $headers, $body);
        if ($res['code'] !== 200) {
            // Если токен протух, очищаем сессию
            if ($res['code'] === 401) unset($_SESSION['utrace_token']); 
            throw new Exception("Reserve Error " . $res['code'] . ": " . $res['body']);
        }
        echo $res['body'];
        exit;
    } 
    
    elseif ($action === 'export') {
        $token = getToken();
        $reserveId = urlencode($_GET['reserveId'] ?? '');
        $headers = ['authorization' => $token];
        
        $res = makeRequest("$API_BASE/codes/export?reserveId=$reserveId&format=xlsx", 'GET', $headers);
        
        if ($res['code'] !== 200) throw new Exception("Export Error " . $res['code']);
        
        // Отдаем файл как XLSX браузеру
        header('Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        header('Content-Disposition: attachment; filename="codes.xlsx"');
        echo $res['body'];
        exit;
    } 
    
    elseif ($action === 'receive') {
        $token = getToken();
        $headers = ['accept' => 'application/json', 'content-type' => 'application/json', 'authorization' => $token];
        $body = ['reserveId' => $input['reserveId']];
        
        $res = makeRequest("$API_BASE/receive", 'POST', $headers, $body);
        
        if ($res['code'] !== 200) throw new Exception("Receive Error " . $res['code']);
        echo json_encode(['success' => true]);
        exit;
    }
    
    else {
        throw new Exception("Invalid action");
    }
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
?>