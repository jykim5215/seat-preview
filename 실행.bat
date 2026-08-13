@echo off
rem 좌석 시야 미리보기 실행 — 로컬 서버 없이 기본 브라우저로 index.html 을 연다.
rem 폴더를 옮겨도 동작하도록 상대 경로(%~dp0) 사용.
start "" "%~dp0index.html"
