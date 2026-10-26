# Changelog

Формат — [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/), версии — [SemVer](https://semver.org/lang/ru/).

## [1.0.0] — 2026-10-26
Первый релиз.

### Добавлено
- Списки чатов: `/addlist`, `/removelist`, `/lists`, `/showlist`
- Чаты: `/addchat` (с проверкой прав бота), `/removechat`, `/checkchats`
- Публикации `/post`: разовые, регулярные (`-regularity`, `-end`), mix-режим (`-mix X in N`), в список или один чат
- Посты с форматированием и медиа (копирование сообщения)
- Управление задачами: `/jobs`, `/pausejob`, `/resumejob`, `/stopjob`
- Журнал публикаций с `message_id` и ссылками в Google Sheets
- Уведомления о добавлении/удалении бота из чатов и об ошибках доставки
- `/version`
