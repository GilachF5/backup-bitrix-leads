# backup-bitrix-leads

## Краткое описание

Резервное копирование лидов Bitrix24 в MySQL: функция выгружает данные из CRM и сохраняет их в отдельной базе для восстановления и сверки.

## Назначение

Бэкап данных из CRM.leads.list в БД mySQL (bitrixDB)

## Параметры функции

- ID функции: `d4e04nvfaa54m4lgq5ai`
- Каталог Yandex Cloud: `sl`
- Статус: `ACTIVE`
- Runtime: `nodejs22`
- Entry point: `index.handler`
- Версий в экспорте: `4`
- HTTP URL: `https://functions.yandexcloud.net/d4e04nvfaa54m4lgq5ai`

## Триггеры

- Нет связанных триггеров в текущем экспорте.

## Переменные окружения

Значения не хранятся в sanitized-экспорте. Реальные значения находятся только в raw/, эту папку нельзя коммитить в GitHub.

- `BITRIX_WEBHOOK`
- `ca_pem`
- `CONFIG_NAME`
- `dateFrom`
- `dateTo`
- `mysql_db`
- `mysql_host`
- `mysql_password`
- `mysql_user`

Пример .env:

```dotenv
BITRIX_WEBHOOK=<set-value>
ca_pem=<set-value>
CONFIG_NAME=<set-value>
dateFrom=<set-value>
dateTo=<set-value>
mysql_db=<set-value>
mysql_host=<set-value>
mysql_password=<set-value>
mysql_user=<set-value>
```

## Локальный запуск

```powershell
cd .\yc-export-author-gilach\sanitized\functions\backup-bitrix-leads
# Положи исходники функции в эту папку: index.js, package.json и остальные файлы.
# Создай .env по примеру выше и event.json с тестовым событием.
npm install
node -e "require('dotenv').config(); const event=require('./event.json'); const mod=require('./index'); Promise.resolve(mod.handler(event, {})).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exit(1)})"
```

Если проект использует ESM (`"type": "module"` в `package.json`), замени команду запуска на динамический `import()`.

Минимальный event.json для ручной проверки:

```json
{}
```

## Деплой новой версии

Перед деплоем проверь, что в папке лежат исходники функции и файл с зависимостями (`package.json` для Node.js или `requirements.txt` для Python).

```powershell
yc serverless function version create --function-id d4e04nvfaa54m4lgq5ai --runtime nodejs22 --entrypoint index.handler --source-path . --execution-timeout 60s
```

Если функции нужны переменные окружения, передавай их через `--environment` или настрой через консоль/секреты. Не коммить реальные токены, пароли, webhook URL и сертификаты в GitHub.

## Файлы экспорта

- `function.json` - описание функции.
- `versions.json` - версии функции с замаскированными значениями переменных окружения.