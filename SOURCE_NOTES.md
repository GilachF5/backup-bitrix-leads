Ссылка на промт
https://chat.deepseek.com/a/chat/s/5964191d-e567-4fa7-a5e8-4ccb23cea4d9

## Python: выгрузка Bitrix → MySQL (рекомендуется для больших объёмов)

См. [bitrix-mysql-py/README.md](bitrix-mysql-py/README.md): батчевый upsert, окно по умолчанию 7 дней, без `SELECT` всех id перед вставкой.

```bash
cd bitrix-mysql-py && pip install -e .
set BITRIX_WEBHOOK=...
set mysql_host=... & set mysql_user=... & set mysql_password=... & set mysql_db=...
bitrix-sync --config new_lead
```

---

Все доступные параметры для params (Node-функция):

{
  "params": {
    "configName": "имя_конфига",           // Загружает конфиг из config/имя_конфига.json
    "mysqlTable": "имя_таблицы",           // Переопределяет таблицу MySQL
    "dateFilterField": "FIELD_NAME",       // Поле для фильтрации по дате
    "dateFrom": -3,                        // Смещение начала периода в днях от сегодня
    "dateTo": 0,                           // Смещение конца периода в днях от сегодня
    "dateFromStr": "01.10.2024",           // Конкретная дата начала (ДД.ММ.ГГГГ)
    "dateToStr": "31.10.2024",             // Конкретная дата окончания
    "primaryKey": "id,assigned_by_id",     // Составной первичный ключ (строка)
    "additionalFilters": {                 // Дополнительные фильтры Bitrix
      "FIELD": "value",                    // Простое значение
      "FIELD2": ["value1", "value2"],      // Массив значений
      "!FIELD3": "",                       // Поле не пустое
      "FIELD4": "not_null"                 // Альтернативный синтаксис для не пустого
    }
  }
}