<?php
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = file_get_contents('php://input');
    if (!empty($input)) {
        file_put_contents('zakaz.xlsx', $input);
        http_response_code(200);
        echo "Success";
        exit;
    }
}
http_response_code(400);
echo "Error";
?>