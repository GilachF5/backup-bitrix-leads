const axios = require('axios');
const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

// Конфигурация из переменных окружения
const BITRIX_WEBHOOK = process.env.BITRIX_WEBHOOK;
const DEFAULT_CONFIG_NAME = process.env.CONFIG_NAME || 'new_lead';

// Настройка MySQL с обработкой SSL
const getMysqlConfig = () => {
  const config = {
    host: process.env.mysql_host,
    port: 3306,
    user: process.env.mysql_user,
    password: process.env.mysql_password,
    database: process.env.mysql_db,
    connectTimeout: 60000,
    acquireTimeout: 60000,
    timeout: 60000,
    reconnect: true
  };

  if (process.env.ca_pem) {
    try {
      config.ssl = {
        rejectUnauthorized: false,
        ca: Buffer.from(process.env.ca_pem)
      };
    } catch (error) {
      console.warn('Ошибка обработки ca_pem, пробуем без SSL:', error.message);
    }
  }

  return config;
};

const BATCH_SIZE = 50;
const API_DELAY = 1000;
const MAX_RECORDS = 50000;

// Список всех полей дат
const DATE_FIELDS = [
  'date_create', 'date_modify', 'date_assigned', 'date_close',
  'data_prezentacii', 'data_tolko_chto_kupilen', 'data_net_otveta',
  'data_ishchet_dengi_aktiv_kredit', 'data_naznachen_skaipe',
  'data_skaipe_podtverzhden', 'data_skaipe_perenesen',
  'data_skaipe_perevod_v_sdelku', 'data_ne_udobno_govorit',
  'uf_crm_1655927709', 'uf_crm_1734076278', 'uf_crm_1734548566',
  'uf_crm_1734548590', 'uf_crm_1734548642', 'uf_crm_1734548664',
  'uf_crm_1734548737', 'uf_crm_1734548787', 'uf_crm_1734548912',
  'uf_crm_1734549160'
];

// Кэш для справочных значений
let fieldValuesCache = null;

// Список полей, которые требуют преобразования ID → Текст
const REFERENCE_FIELDS = [
  'SOURCE_ID',
  'STATUS_ID', 
  'ASSIGNED_BY_ID',
  'CREATED_BY_ID',
  'UF_CRM_1650896347', // project
  'UF_CRM_1666190537',
  'F_CRM_1697036481'   // bis_stat
];

// =========== ФУНКЦИИ ДЛЯ РАБОТЫ С КОНФИГУРАЦИЯМИ ===========

// Загрузка конфигурации с учетом параметров
function loadConfig(params) {
  // Приоритет: 1. Параметры из вызова, 2. Переменная окружения, 3. Значение по умолчанию
  const configName = params.configName || DEFAULT_CONFIG_NAME;
  
  console.log(`Используется конфиг: ${configName}`);
  console.log(`(из параметров: ${params.configName || 'не указано'}, из env: ${DEFAULT_CONFIG_NAME})`);
  
  const configPath = path.join(__dirname, 'config', `${configName}.json`);
  
  try {
    if (!fs.existsSync(configPath)) {
      throw new Error(`Конфигурационный файл ${configPath} не найден`);
    }
    
    const configContent = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(configContent);
    
    // Установка значений по умолчанию
    const defaultConfig = {
      name: configName,
      mysql_table: configName,
      date_filter_field: 'DATE_CREATE',
      date_from_offset: -1,
      date_to_offset: 0,
      mapping_file: `mappings/${configName}.txt`,
      primary_key: ['id'],
      additional_filters: {}
    };
    
    // Объединяем конфиг из файла с параметрами
    const mergedConfig = { ...defaultConfig, ...config };
    
    // Переопределяем параметрами из вызова функции (если они переданы)
    if (params.dateFrom !== undefined) mergedConfig.date_from_offset = params.dateFrom;
    if (params.dateTo !== undefined) mergedConfig.date_to_offset = params.dateTo;
    if (params.mysqlTable) mergedConfig.mysql_table = params.mysqlTable;
    if (params.dateFilterField) mergedConfig.date_filter_field = params.dateFilterField;
    
    // Добавляем дополнительные фильтры из параметров
    if (params.additionalFilters) {
      try {
        const additionalFilters = typeof params.additionalFilters === 'string' 
          ? JSON.parse(params.additionalFilters) 
          : params.additionalFilters;
        
        mergedConfig.additional_filters = {
          ...mergedConfig.additional_filters,
          ...additionalFilters
        };
      } catch (e) {
        console.warn('Не удалось распарсить additionalFilters:', e.message);
      }
    }
    
    console.log(`Конфигурация "${configName}" загружена успешно`);
    return mergedConfig;
    
  } catch (error) {
    console.error(`Ошибка загрузки конфигурации ${configName}:`, error.message);
    
    // Создаем конфиг из параметров (резервный вариант)
    return {
      name: configName,
      mysql_table: params.mysqlTable || configName,
      date_filter_field: params.dateFilterField || 'DATE_CREATE',
      date_from_offset: params.dateFrom !== undefined ? params.dateFrom : -1,
      date_to_offset: params.dateTo !== undefined ? params.dateTo : 0,
      mapping_file: `mappings/${configName}.txt`,
      primary_key: params.primaryKey ? 
        (Array.isArray(params.primaryKey) ? params.primaryKey : params.primaryKey.split(',')) 
        : ['id'],
      additional_filters: params.additionalFilters || {}
    };
  }
}

// Расчет дат на основе смещений или конкретных дат
function calculateDates(dateFromOffset, dateToOffset, dateFromStr, dateToStr) {
  // Если переданы конкретные даты в формате ДД.ММ.ГГГГ
  if (dateFromStr && dateToStr) {
    return {
      dateFrom: dateFromStr,
      dateTo: dateToStr
    };
  }
  
  // Иначе используем смещения от текущей даты
  const today = new Date();
  
  const dateFrom = new Date(today);
  dateFrom.setDate(today.getDate() + dateFromOffset);
  
  const dateTo = new Date(today);
  dateTo.setDate(today.getDate() + dateToOffset);
  
  // Форматируем в ДД.ММ.ГГГГ
  const formatDate = (date) => {
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    return `${day}.${month}.${year}`;
  };
  
  return {
    dateFrom: formatDate(dateFrom),
    dateTo: formatDate(dateTo)
  };
}

// Загрузка mapping полей из файла
function loadFieldMapping(mappingFile) {
  const fieldMapping = {};
  
  const defaultFields = {
    'ID': 'id',
    'DATE_CREATE': 'date_create'
  };
  
  Object.assign(fieldMapping, defaultFields);
  
  try {
    const mappingPath = path.join(__dirname, mappingFile);
    
    if (fs.existsSync(mappingPath)) {
      const fieldsContent = fs.readFileSync(mappingPath, 'utf8');
      const lines = fieldsContent.split('\n').filter(line => line.trim());
      
      lines.forEach(line => {
        const [bitrixField, mysqlField] = line.split(';').map(field => field.trim());
        if (bitrixField && mysqlField && !fieldMapping[bitrixField]) {
          fieldMapping[bitrixField] = mysqlField;
        }
      });
      console.log(`Загружено ${lines.length} полей из ${mappingFile}`);
    } else {
      console.log(`Файл ${mappingFile} не найден, используем только стандартные поля`);
    }
  } catch (error) {
    console.error(`Ошибка чтения ${mappingFile}:`, error.message);
  }
  
  console.log(`Всего mapping полей: ${Object.keys(fieldMapping).length}`);
  
  return fieldMapping;
}

// =========== ОСНОВНЫЕ ФУНКЦИИ ===========

// Функция для конвертации UTC времени в московское время (+3 часа)
function convertUTCtoMoscowTime(utcDateString) {
  if (!utcDateString) return null;
  
  try {
    const date = new Date(utcDateString);
    if (isNaN(date.getTime())) return null;
    
    date.setHours(date.getHours() + 3);
    return date.toISOString().slice(0, 19).replace('T', ' ');
  } catch (error) {
    console.warn('Ошибка конвертации времени:', error.message);
    return null;
  }
}

// Функция для нормализации телефона
function normalizePhone(phoneValue) {
  if (!phoneValue) return null;
  
  try {
    let phone = extractFieldValue(phoneValue);
    if (!phone) return null;
    
    let digits = phone.replace(/\D/g, '');
    if (!digits) return null;
    
    // Обрабатываем разные форматы
    if (digits.startsWith('8') && digits.length >= 11) {
      digits = '7' + digits.substring(1);
    } else if (digits.startsWith('+7') && digits.length >= 12) {
      digits = '7' + digits.substring(2);
    } else if (digits.startsWith('7') && digits.length >= 11) {
      // Уже в правильном формате
    } else if (digits.length === 10) {
      digits = '7' + digits;
    } else if (digits.startsWith('+') && digits.length > 11) {
      digits = digits.replace(/^\+/, '');
    }
    
    if (digits.startsWith('7')) {
      digits = digits.substring(0, 11);
    }
    
    if (digits.length === 11 && digits.startsWith('7')) {
      return digits;
    }
    
    return digits || phone;
    
  } catch (error) {
    console.warn(`Ошибка нормализации телефона:`, error.message);
    return extractFieldValue(phoneValue);
  }
}

// Получение справочных значений из Bitrix24
async function getFieldValues(webhookUrl) {
  if (fieldValuesCache) {
    console.log('Используем кэшированные справочные значения');
    return fieldValuesCache;
  }

  console.log('Начинаем загрузку справочных значений из Bitrix24...');
  
  const fieldValues = {};
  REFERENCE_FIELDS.forEach(field => { fieldValues[field] = {}; });

  try {
    // Загрузка статусов
    const statusTypes = ['SOURCE', 'STATUS'];
    for (const type of statusTypes) {
      try {
        const response = await axios.get(`${webhookUrl}/crm.status.list`, {
          params: { 'filter[ENTITY_ID]': type },
          timeout: 30000
        });

        if (response.data?.result) {
          response.data.result.forEach(item => {
            const key = `${type}_ID`;
            fieldValues[key] = fieldValues[key] || {};
            fieldValues[key][item.STATUS_ID] = item.NAME;
          });
        }
      } catch (error) {
        console.error(`Ошибка при загрузке ${type}:`, error.message);
      }
    }

    // Загрузка полей лида
    try {
      const response = await axios.get(`${webhookUrl}/crm.lead.fields`, { timeout: 30000 });
      if (response.data?.result) {
        REFERENCE_FIELDS.forEach(fieldName => {
          if (response.data.result[fieldName]?.items) {
            response.data.result[fieldName].items.forEach(item => {
              const id = item.ID || item.VALUE_ID || item.STATUS_ID;
              const value = item.VALUE || item.NAME;
              if (id && value) {
                fieldValues[fieldName][id] = value;
              }
            });
          }
        });
      }
    } catch (error) {
      console.error('Ошибка при загрузке полей лида:', error.message);
    }

    // Загрузка пользователей
    console.log('Загрузка пользователей...');
    try {
      let userStart = 0;
      let hasMoreUsers = true;
      
      while (hasMoreUsers) {
        const response = await axios.get(`${webhookUrl}/user.get`, {
          params: { start: userStart },
          timeout: 30000
        });

        if (response.data?.result?.length > 0) {
          response.data.result.forEach(user => {
            const userId = user.ID?.toString();
            if (!userId) return;
            
            let fullName = '';
            if (user.NAME && user.LAST_NAME) {
              fullName = `${user.NAME} ${user.LAST_NAME}`.trim();
            } else if (user.NAME) {
              fullName = user.NAME;
            } else if (user.LAST_NAME) {
              fullName = user.LAST_NAME;
            } else if (user.EMAIL) {
              fullName = user.EMAIL;
            } else {
              fullName = `User ${userId}`;
            }
            
            fieldValues['ASSIGNED_BY_ID'][userId] = fullName;
            fieldValues['CREATED_BY_ID'][userId] = fullName;
          });

          hasMoreUsers = response.data.result.length >= 50;
          userStart += 50;
        } else {
          hasMoreUsers = false;
        }
      }
    } catch (error) {
      console.error('Ошибка при загрузке пользователей:', error.message);
    }

  } catch (error) {
    console.error('Критическая ошибка при получении справочных данных:', error.message);
  }

  console.log('\n=== СТАТИСТИКА ПО СПРАВОЧНЫМ ЗНАЧЕНИЯМ ===');
  Object.keys(fieldValues).forEach(key => {
    if (fieldValues[key] && typeof fieldValues[key] === 'object') {
      console.log(`${key}: ${Object.keys(fieldValues[key]).length} значений`);
    }
  });
  console.log('========================================\n');

  fieldValuesCache = fieldValues;
  return fieldValues;
}

// Функция для получения текстового значения
function getTextValue(fieldName, value, fieldValues) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const valueStr = String(value);
  
  if (fieldValues?.[fieldName]?.[valueStr]) {
    return fieldValues[fieldName][valueStr];
  }
  
  return valueStr;
}

// Функция для извлечения значений из объектов Bitrix
function extractFieldValue(fieldData) {
  if (!fieldData) return null;
  
  if (Array.isArray(fieldData)) {
    if (fieldData.length > 0 && fieldData[0].VALUE) {
      return fieldData[0].VALUE;
    }
    return null;
  }
  
  if (typeof fieldData === 'object' && fieldData.VALUE) {
    return fieldData.VALUE;
  }
  
  return fieldData;
}

// Определяем тип поля для MySQL
function getMysqlColumnType(fieldName) {
  const fieldNameLower = fieldName.toLowerCase();
  
  if (DATE_FIELDS.includes(fieldNameLower)) {
    return 'DATETIME';
  }
  
  if (fieldName.endsWith('_id') || fieldName === 'id') {
    return 'VARCHAR(255)';
  }
  
  if (fieldName === 'phone_normalized') {
    return 'VARCHAR(20)';
  }
  
  return 'TEXT';
}

// Создание таблицы с поддержкой составных ключей
async function createTableIfNotExists(connection, fieldMapping, tableName, primaryKey = ['id']) {
  try {
    const columns = [];
    const uniqueColumns = new Set();
    
    // Сначала добавляем все поля из fieldMapping
    Object.values(fieldMapping).forEach(column => {
      if (!uniqueColumns.has(column)) {
        if (primaryKey.includes(column)) {
          // Поля, входящие в первичный ключ
          columns.push(`${column} VARCHAR(255) NOT NULL`);
        } else if (column === 'phone') {
          columns.push('phone_original TEXT');
          columns.push('phone_normalized VARCHAR(20)');
          uniqueColumns.add('phone_original');
          uniqueColumns.add('phone_normalized');
        } else {
          const columnType = getMysqlColumnType(column);
          columns.push(`${column} ${columnType}`);
        }
        uniqueColumns.add(column);
      }
    });
    
    // Добавляем определение первичного ключа
    if (primaryKey.length === 1) {
      columns.push(`PRIMARY KEY (${primaryKey[0]})`);
    } else {
      columns.push(`PRIMARY KEY (${primaryKey.join(', ')})`);
    }
    
    // Добавляем индексы
    columns.push('INDEX idx_date_create (date_create)');
    columns.push('INDEX idx_phone_norm (phone_normalized)');
    if (uniqueColumns.has('assigned_by_id') && !primaryKey.includes('assigned_by_id')) {
      columns.push('INDEX idx_assigned (assigned_by_id(100))');
    }
    
    const createTableSQL = `
      CREATE TABLE IF NOT EXISTS ${tableName} (
        ${columns.join(',\n        ')}
      )
    `;
    
    await connection.query(createTableSQL);
    console.log(`Таблица ${tableName} проверена/создана`);
    console.log(`Первичный ключ: (${primaryKey.join(', ')})`);
    
  } catch (error) {
    console.error('Ошибка при создании таблицы:', error.message);
    throw error;
  }
}

// Преобразование значения для MySQL
function formatValueForMySQL(value, fieldName, bitrixFieldName, fieldValues) {
  if (value === null || value === undefined) {
    return null;
  }
  
  const fieldNameLower = fieldName.toLowerCase();
  
  if (DATE_FIELDS.includes(fieldNameLower) && value) {
    return convertUTCtoMoscowTime(value);
  }
  
  if (bitrixFieldName && REFERENCE_FIELDS.includes(bitrixFieldName)) {
    return getTextValue(bitrixFieldName, value, fieldValues);
  }
  
  if (typeof value === 'object') {
    const extracted = extractFieldValue(value);
    return extracted !== null ? extracted : JSON.stringify(value);
  }
  
  return value.toString();
}

// Преобразование даты для Bitrix API
function formatDateForBitrix(dateString, isEndDate = false) {
  const [day, month, year] = dateString.split('.');
  
  if (isEndDate) {
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T23:59:59+03:00`;
  } else {
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00+03:00`;
  }
}

// Получение данных из Bitrix24 с учетом фильтров
async function getBitrixData(config, fieldMapping, fieldValues) {
  let allData = [];
  let start = 0;
  
  const selectFields = Object.keys(fieldMapping);
  
  // Расчет дат
  const dates = calculateDates(
    config.date_from_offset, 
    config.date_to_offset,
    config.dateFrom,  // Конкретные даты из параметров
    config.dateTo
  );
  
  const startDate = formatDateForBitrix(dates.dateFrom, false);
  const endDate = formatDateForBitrix(dates.dateTo, true);
  
  console.log(`\nКонфигурация: ${config.name}`);
  console.log(`Таблица MySQL: ${config.mysql_table}`);
  console.log(`Поле для фильтрации по дате: ${config.date_filter_field}`);
  console.log(`Период: ${dates.dateFrom} - ${dates.dateTo}`);
  console.log(`Дополнительные фильтры:`, config.additional_filters);
  
  // Формируем параметры фильтра
  const filterParams = {
    [`filter[>=${config.date_filter_field}]`]: startDate,
    [`filter[<=${config.date_filter_field}]`]: endDate
  };
  
  // Добавляем дополнительные фильтры
  if (config.additional_filters) {
    Object.entries(config.additional_filters).forEach(([field, value]) => {
      if (value === 'not_null') {
        filterParams[`filter[!${field}]`] = '';
      } else if (Array.isArray(value)) {
        filterParams[`filter[${field}]`] = value;
      } else {
        filterParams[`filter[${field}]`] = value;
      }
    });
  }
  
  console.log('Параметры запроса к Bitrix24:', filterParams);
  
  while (allData.length < MAX_RECORDS) {
    try {
      const params = {
        ...filterParams,
        'select': selectFields,
        'start': start,
        'order': { [config.date_filter_field]: 'ASC' }
      };
      
      const response = await axios.get(`${BITRIX_WEBHOOK}/crm.lead.list`, {
        params,
        timeout: 30000
      });

      const data = response.data.result || [];
      if (data.length === 0) {
        console.log('Больше данных нет');
        break;
      }

      allData = allData.concat(data);
      start += data.length;
      
      console.log(`Загружено ${allData.length} записей...`);
      
      if (data.length < BATCH_SIZE) {
        console.log('Получен последний пакет данных');
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, API_DELAY));

    } catch (error) {
      console.error('Ошибка загрузки данных из Bitrix24:', error.message);
      break;
    }
  }

  return allData;
}

// Преобразование данных в формат для MySQL
function transformDataForMySQL(data, fieldMapping, fieldValues) {
  console.log('Начинаем преобразование данных...');
  
  return data.map((item, index) => {
    const transformed = {};
    
    Object.keys(fieldMapping).forEach(bitrixField => {
      const mysqlField = fieldMapping[bitrixField];
      const value = item[bitrixField];
      
      transformed[mysqlField] = formatValueForMySQL(value, mysqlField, bitrixField, fieldValues);
    });
    
    // Обработка телефонов
    if (item.PHONE) {
      const originalPhone = extractFieldValue(item.PHONE);
      transformed['phone_original'] = originalPhone;
      
      const normalizedPhone = normalizePhone(item.PHONE);
      transformed['phone_normalized'] = normalizedPhone;
      
      if (transformed.phone !== undefined) {
        delete transformed.phone;
      }
    }
    
    return transformed;
  });
}

// Вставка данных с поддержкой составных ключей
async function insertData(connection, data, fieldMapping, tableName, primaryKey = ['id']) {
  if (data.length === 0) {
    console.log('Нет данных для вставки');
    return { inserted: 0, duplicates: 0 };
  }
  
  const allColumns = new Set();
  Object.keys(data[0]).forEach(column => {
    if (column !== 'phone') {
      allColumns.add(column);
    }
  });
  
  const columns = Array.from(allColumns);
  
  try {
    console.log(`\nВставка ${data.length} записей в ${tableName}...`);
    console.log(`Колонки: ${columns.join(', ')}`);
    console.log(`Первичный ключ: (${primaryKey.join(', ')})`);
    
    const batchSize = 100;
    let totalInserted = 0;
    let totalDuplicates = 0;
    
    for (let i = 0; i < data.length; i += batchSize) {
      const batch = data.slice(i, i + batchSize);
      
      // Формируем значения для вставки
      const values = batch.map(item => 
        columns.map(column => item[column] === undefined ? null : item[column])
      );
      
      try {
        // Для составного ключа используем ON DUPLICATE KEY UPDATE
        if (primaryKey.length > 1) {
          // Формируем часть запроса для обновления
          const updateColumns = columns.filter(col => !primaryKey.includes(col));
          const updateSet = updateColumns.map(col => `${col} = VALUES(${col})`).join(', ');
          
          const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) 
                       VALUES ? 
                       ON DUPLICATE KEY UPDATE ${updateSet}`;
          
          const [result] = await connection.query(sql, [values]);
          
          totalInserted += result.affectedRows;
          const duplicatesInBatch = result.affectedRows - result.changedRows;
          totalDuplicates += duplicatesInBatch;
          
          console.log(`Пакет ${Math.floor(i/batchSize) + 1}: 
            Всего обработано: ${result.affectedRows}, 
            Вставлено новых: ${result.changedRows}, 
            Дубликатов: ${duplicatesInBatch}`);
        } else {
          // Для простого ключа используем INSERT IGNORE
          const [result] = await connection.query(
            `INSERT IGNORE INTO ${tableName} (${columns.join(', ')}) VALUES ?`,
            [values]
          );
          
          totalInserted += result.affectedRows;
          const duplicatesInBatch = batch.length - result.affectedRows;
          totalDuplicates += duplicatesInBatch;
          
          console.log(`Пакет ${Math.floor(i/batchSize) + 1}: 
            Вставлено: ${result.affectedRows}, 
            Дубликатов: ${duplicatesInBatch}`);
        }
        
        if (i + batchSize < data.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
      } catch (sqlError) {
        console.error(`Ошибка при вставке пакета ${Math.floor(i/batchSize) + 1}:`, sqlError.message);
        // Для отладки выводим первую запись из проблемного пакета
        if (batch.length > 0) {
          const sample = batch[0];
          console.log('Пример записи с ошибкой:');
          primaryKey.forEach(pk => {
            console.log(`  ${pk}: ${sample[pk]}`);
          });
        }
        throw sqlError;
      }
    }
    
    if (totalDuplicates > 0) {
      console.log(`Всего дубликатов: ${totalDuplicates}`);
    }
    
    return { 
      inserted: totalInserted, 
      duplicates: totalDuplicates,
      totalProcessed: data.length 
    };
    
  } catch (error) {
    console.error('Ошибка при вставке:', error.message);
    if (error.sql) console.error('SQL:', error.sql);
    throw error;
  }
}

// =========== ОСНОВНАЯ ФУНКЦИЯ ===========
exports.handler = async (event, context) => {
  console.log('=== BITRIX24 TO MYSQL DATA SYNC ===');
  console.log(`Конфиг по умолчанию из переменных окружения: ${DEFAULT_CONFIG_NAME}`);
  
  let connection;
  let assignedStats = { empty: 0, id: 0, name: 0 };
  let phoneStats = { original: 0, normalized: 0, valid: 0 };
  
  try {
    // Проверка обязательных переменных
    if (!BITRIX_WEBHOOK) throw new Error('Не указана переменная BITRIX_WEBHOOK');
    
    // Получаем параметры из вызова
    let params = {};
    
    // Пробуем разные способы получить параметры
    if (event && event.params) {
      params = event.params;
    } else if (event && event.body) {
      try {
        const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
        params = body.params || body;
      } catch (e) {
        console.warn('Не удалось распарсить тело запроса:', e.message);
      }
    } else if (context && context.params) {
      params = context.params;
    }
    
    console.log('Полученные параметры:', JSON.stringify(params, null, 2));
    
    // Загрузка конфигурации с учетом параметров
    const config = loadConfig(params);
    console.log(`Используется конфигурация: ${config.name}`);
    console.log(`Описание: ${config.description || 'нет описания'}`);
    
    // Загрузка mapping полей
    const fieldMapping = loadFieldMapping(config.mapping_file);
    
    // Загрузка справочных значений
    console.log('\nЗагрузка справочников из Bitrix24...');
    const fieldValues = await getFieldValues(BITRIX_WEBHOOK);
    
    // Подключение к MySQL
    console.log('\nПодключение к MySQL...');
    connection = await mysql.createConnection(getMysqlConfig());
    console.log('MySQL подключен');
    
    // Создание/проверка таблицы
    await createTableIfNotExists(connection, fieldMapping, config.mysql_table, config.primary_key);
    
    // Для составного ключа проверяем существующие записи по    -другому
    let existingIds = new Set();
    if (config.primary_key.length === 1) {
      // Простой ключ - просто проверяем id
      console.log(`\nПроверка существующих записей в ${config.mysql_table}...`);
      const [existingRows] = await connection.query(`SELECT ${config.primary_key[0]} FROM ${config.mysql_table}`);
      existingIds = new Set(existingRows.map(row => row[config.primary_key[0]]?.toString()));
    } else {
      // Составной ключ - не проверяем, используем ON DUPLICATE KEY UPDATE
      console.log(`\nДля таблицы ${config.mysql_table} используется составной ключ: (${config.primary_key.join(', ')})`);
      console.log('Проверка существующих записей не требуется, будет использоваться ON DUPLICATE KEY UPDATE');
    }
    
    console.log(`Найдено существующих записей: ${existingIds.size}`);
    
    // Загрузка данных из Bitrix
    const bitrixData = await getBitrixData(config, fieldMapping, fieldValues);
    console.log(`\nЗагружено из Bitrix24: ${bitrixData.length} записей`);
    
    // Фильтруем новые записи (только для простого ключа)
    let newData;
    if (config.primary_key.length === 1) {
      newData = bitrixData.filter(item => item.ID && !existingIds.has(item.ID.toString()));
    } else {
      // Для составного ключа берем все данные
      newData = bitrixData.filter(item => item.ID);
    }
    
    console.log(`Записей для обработки: ${newData.length}`);
    
    let insertResult = { inserted: 0, duplicates: 0, totalProcessed: 0 };
    
    if (newData.length > 0) {
      // Преобразуем данные
      const transformedData = transformDataForMySQL(newData, fieldMapping, fieldValues);
      
      // Анализ результатов
      console.log('\n=== АНАЛИЗ РЕЗУЛЬТАТОВ ===');
      
      // Анализ ASSIGNED_BY_ID
      assignedStats = transformedData.reduce((stats, item) => {
        const value = item.assigned_by_id;
        if (!value) {
          stats.empty++;
        } else if (typeof value === 'string') {
          if (/^\d+$/.test(value)) {
            stats.id++;
          } else {
            stats.name++;
          }
        }
        return stats;
      }, { empty: 0, id: 0, name: 0 });
      
      console.log(`ASSIGNED_BY_ID - Пустых: ${assignedStats.empty}`);
      console.log(`ASSIGNED_BY_ID - ID (только цифры): ${assignedStats.id}`);
      console.log(`ASSIGNED_BY_ID - Имена: ${assignedStats.name}`);
      
      // Анализ телефонов
      phoneStats = transformedData.reduce((stats, item) => {
        if (item.phone_normalized) stats.normalized++;
        if (item.phone_original) stats.original++;
        if (item.phone_normalized?.length === 11 && item.phone_normalized.startsWith('7')) {
          stats.valid++;
        }
        return stats;
      }, { original: 0, normalized: 0, valid: 0 });
      
      console.log(`\nТелефоны - Оригинальных: ${phoneStats.original}`);
      console.log(`Телефоны - Нормализованных: ${phoneStats.normalized}`);
      console.log(`Телефоны - Валидных (790...): ${phoneStats.valid}`);
      
      // Вставляем в MySQL
      insertResult = await insertData(connection, transformedData, fieldMapping, config.mysql_table, config.primary_key);
      
    } else {
      console.log('\nНет данных для обработки');
    }
    
    await connection.end();
    console.log('\nMySQL отключен');
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        config: config.name,
        params: params,
        defaultConfig: DEFAULT_CONFIG_NAME,
        stats: {
          table: config.mysql_table,
          primary_key: config.primary_key,
          totalInBitrix: bitrixData.length,
          existingInMySQL: existingIds.size,
          recordsToProcess: newData.length,
          inserted: insertResult.inserted,
          duplicates: insertResult.duplicates,
          totalProcessed: insertResult.totalProcessed,
          assignedByIdStats: assignedStats,
          phoneStats: phoneStats
        }
      })
    };
    
  } catch (error) {
    console.error('КРИТИЧЕСКАЯ ОШИБКА:', error.message);
    console.error(error.stack);
    
    if (connection) {
      try {
        await connection.end();
      } catch (e) {
        console.error('Ошибка отключения от MySQL:', e.message);
      }
    }
    
    return {
      statusCode: 500,
      body: JSON.stringify({
        success: false,
        error: error.message,
        defaultConfig: DEFAULT_CONFIG_NAME
      })
    };
  }
};