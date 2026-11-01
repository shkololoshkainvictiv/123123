document.getElementById('downloadBtn').addEventListener('click', async () => {
    const gtin = document.getElementById('gtin').value.trim();
    const count = parseInt(document.getElementById('count').value, 10);
    const statusBox = document.getElementById('statusBox');
    const btn = document.getElementById('downloadBtn');

    if (!gtin || !count) return alert('Заполните все поля');

    btn.disabled = true;
    statusBox.style.color = '#2563eb';
    
    try {
        // ШАГ 1: Авторизация + Reserve (делает PHP)
        statusBox.textContent = '1/3 Бронируем коды...';
        const reserveRes = await fetch('api.php?action=reserve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gtin, count })
        });
        const reserveData = await reserveRes.json();
        
        if (!reserveRes.ok || reserveData.error) {
            throw new Error(reserveData.error || 'Ошибка Reserve');
        }
        const reserveId = reserveData.reserveId;

        // ШАГ 2: Export (Скачивание файла через PHP)
        statusBox.textContent = '2/3 Скачиваем файл...';
        const exportRes = await fetch(`api.php?action=export&reserveId=${encodeURIComponent(reserveId)}`);
        if (!exportRes.ok) throw new Error('Ошибка формирования файла');
        
        const blob = await exportRes.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `codes_${gtin}.xlsx`;
        a.click();
        URL.revokeObjectURL(a.href);

        // ШАГ 3: Receive (Подтверждение)
        statusBox.textContent = '3/3 Подтверждаем получение...';
        const receiveRes = await fetch('api.php?action=receive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reserveId })
        });
        const receiveData = await receiveRes.json();
        
        if (!receiveRes.ok || receiveData.error) {
            throw new Error(receiveData.error || 'Ошибка Receive');
        }

        statusBox.style.color = '#16a34a';
        statusBox.textContent = '✅ Готово! Файл скачан.';
        
    } catch (err) {
        console.error(err);
        statusBox.style.color = '#dc2626';
        statusBox.textContent = `❌ ${err.message}`;
    } finally {
        btn.disabled = false;
    }
});