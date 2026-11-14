<?php
// PHP 8+ — cURL extension. Run: php docs/quickstarts/php.php
$sui = getenv('SUI') ?: 'http://127.0.0.1:8787';

$ch = curl_init("$sui/v1/chat/completions");
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => ['content-type: application/json'],
    CURLOPT_POSTFIELDS => json_encode([
        'model' => 'chat-default',
        'messages' => [['role' => 'user', 'content' => 'Explain a circuit breaker in one sentence.']],
    ]),
    CURLOPT_TIMEOUT => 120,
]);

$body = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

$json = json_decode($body, true);

if ($status !== 200) {
    // The gateway's error messages are already sentences with a next step.
    fwrite(STDERR, ($json['error']['message'] ?? "HTTP $status") . PHP_EOL);
    exit(1);
}

echo $json['choices'][0]['message']['content'] . PHP_EOL;
printf("— %s %s %dms \$%s%s", $json['sui']['provider'], $json['sui']['modelId'], $json['sui']['latencyMs'], $json['sui']['costUsd'], PHP_EOL);
