<?php
echo "1. Remote_Addr (обычный IP): " . $_SERVER['REMOTE_ADDR'] . "<br>";
echo "2. X-Real-IP: " . (isset($_SERVER['HTTP_X_REAL_IP']) ? $_SERVER['HTTP_X_REAL_IP'] : 'Не используется') . "<br>";
echo "3. X-Forwarded-For: " . (isset($_SERVER['HTTP_X_FORWARDED_FOR']) ? $_SERVER['HTTP_X_FORWARDED_FOR'] : 'Не используется') . "<br>";
?>
