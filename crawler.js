// 파일 이름: crawler.js (페이지네이션 최종 수정 + main 함수 호출 수정, 전체 코드)

const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { URLSearchParams, URL } = require('url');

// --- 필터 코드 데이터 ---
const filterCodes = {
    welfare: { "年間休日120日以上": "1830" }
};
// *** 중요: 실제 페이로드에서 확인된 파라미터 이름으로 매핑 ***
const categoryToParamMap = {
    welfare: 'corpWelfareArray'
};

// --- 쿠키 Jar를 사용하는 axios 클라이언트 생성 ---
const cookieJar = new CookieJar();
const client = wrapper(axios.create({
    jar: cookieJar,
    withCredentials: true,
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: status => status < 500
}));

const delay = (seconds) => new Promise(resolve => setTimeout(resolve, seconds * 1000));

// --- 검색 폼 페이지에서 CSRF와 VS 및 기타 숨겨진 값 추출 함수 ---
async function getHiddenFormParams(url, formSelector = '#displaySearchCorpListByGenCondDispForm') {
    console.log(`[정보] 숨겨진 폼 파라미터 가져오기 시도: ${url}`);
    try {
        const headers = {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Accept-Language': 'ko-KR,ko;q=0.9',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Whale/4.30.291.11 Safari/537.36',
        };
        const response = await client.get(url, { headers });
        const $ = cheerio.load(response.data);
        const form = $(formSelector);
        if (form.length === 0) {
            console.error(`[오류] 폼(${formSelector})을 찾을 수 없습니다.`);
            return null;
        }

        const hiddenParams = {};
        form.find('input[type="hidden"]').each((i, elem) => {
            const name = $(elem).attr('name');
            const value = $(elem).val();
            if (name) hiddenParams[name] = value || '';
        });

        if (!hiddenParams['_csrf'] || !hiddenParams['_vs']) {
             console.error('[오류] CSRF 또는 VS 토큰을 폼에서 찾을 수 없습니다.');
             const debugHtmlPath = `debug_csrf_page.html`;
             try { fs.writeFileSync(debugHtmlPath, response.data); } catch (e) {}
             console.error(`[정보] 디버깅용 HTML 저장됨: ${debugHtmlPath}`);
             return null;
        }

        console.log('[정보] 숨겨진 폼 파라미터 추출 성공.');
        return hiddenParams;

    } catch (error) {
        console.error(`[오류] 숨겨진 폼 파라미터 가져오기 실패: ${error.message}`);
        if (error.response) console.error('[오류 상세] 응답 상태:', error.response.status);
        return null;
    }
}


// --- 검색 함수 (요청 URL 및 Payload 동적 구성) ---
async function searchMynavi(keyword, filterParams = {}, csrfToken, vsToken, offset = 0, hiddenFormParams = {}) { // hiddenFormParams 기본값 빈 객체로 변경
  try {
    console.log(`[정보] 마이나비 검색 요청 (키워드: "${keyword}", 오프셋: ${offset})...`);

    const searchUrlPath = offset === 0 ? '/26/pc/corpinfo/displayCorpSearch/doSearch' : '/26/pc/corpinfo/searchCorpListByGenCond/doSpecifiedPage';
    const searchUrl = `https://job.mynavi.jp${searchUrlPath}`;

    const postData = new URLSearchParams();

    // 1. 필수 검색 조건
    postData.append('srchWord', keyword || '');
    postData.append('srchWordTgt', '1');

    // 2. 적용된 필터
    for (const paramNameMapped in filterParams) {
        const actualParamName = categoryToParamMap[paramNameMapped] || paramNameMapped;
        const values = filterParams[paramNameMapped];
        if (Array.isArray(values)) {
            values.forEach(value => postData.append(actualParamName, value));
            postData.append(`_${actualParamName}`, 'on');
        }
    }

    // 3. 숨겨진 파라미터 (전달받은 hiddenFormParams 사용)
    if (!hiddenFormParams || !csrfToken || !vsToken) { // csrf/vs는 명시적으로 체크
        console.error('[오류] CSRF/VS 토큰 등 필수 숨겨진 파라미터가 없습니다.');
        return null;
    }
    // 모든 hidden 파라미터 추가 (토큰 포함)
    for (const key in hiddenFormParams) {
        if (key !== 'displaytop') { // displaytop은 아래에서 별도 설정
             postData.append(key, hiddenFormParams[key]);
        }
    }
    // CSRF/VS 는 확실히 전달받은 값으로 설정 (hiddenFormParams에 있어도 덮어씀)
    postData.set('_csrf', csrfToken);
    postData.set('_vs', vsToken);


    // 4. 페이지네이션 파라미터
    postData.set('displaytop', offset.toString());

    // 5. 추가/수정해야 할 파라미터 (두 번째 페이지 요청 Payload 참고)
    if (offset > 0) {
        postData.set('actionMode', 'searchFw');
    } else {
         postData.delete('actionMode');
    }

    // 6. 기본값/상태값 (Payload 참고) - hiddenFormParams에 포함되지 않은 경우 대비
    if (!postData.has('limitedIndMainRadio')) postData.append('limitedIndMainRadio', '0');
    if (!postData.has('hqRegionCorpsRadio')) postData.append('hqRegionCorpsRadio', '3');
    if (!postData.has('searchRangeOcc')) postData.append('searchRangeOcc', '0');
    if (!postData.has('welfareSearchMatchMethod')) postData.append('welfareSearchMatchMethod', '0');
    // ... (다른 라디오 기본값 필요시 추가) ...


    console.log('[정보] 최종 전송 데이터:', postData.toString().substring(0, 400) + '...');

    // 요청 헤더
    const headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Cache-Control': 'max-age=0',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://job.mynavi.jp',
        'Referer': offset === 0 ? 'https://job.mynavi.jp/26/pc/corpinfo/displayCorpSearch/index' : 'https://job.mynavi.jp/26/pc/corpinfo/displayCorpSearch/doSearch', // 이전 요청 경로 기반
        'Sec-Ch-Ua': '"Chromium";v="132", "Whale";v="4", "Not.A/Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"macOS"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Whale/4.30.291.11 Safari/537.36'
    };

    console.log(`[정보] POST 요청 전송: ${searchUrl} (오프셋 ${offset})`);
    const response = await client.post(searchUrl, postData.toString(), { headers });

    console.log(`[정보] 응답 상태 코드 (오프셋 ${offset}):`, response.status);

    const responseData = response.data;
    const filenameSafeKeyword = (keyword || 'no_keyword').replace(/[^a-zA-Z0-9]/g, '_');
    const resultHtmlPath = `mynavi_post_result_${filenameSafeKeyword}_offset${offset}.html`;
    try { fs.writeFileSync(resultHtmlPath, responseData); console.log(`[정보] 응답 HTML 저장됨: ${resultHtmlPath}`); } catch (e) {}

    if (response.status === 200) {
        if (responseData.includes('認証の有効期限が切れています') || responseData.includes('Bad Request') || responseData.includes('不正なリクエスト')) {
             /* 오류 처리 */ return null;
        }

        const $ = cheerio.load(responseData);
        const totalResultText = $('h2.hdg01.refinement span#searchResultkensuuRef').text().match(/(\d+)/);
        const totalResults = totalResultText ? parseInt(totalResultText[1], 10) : -1;
        if(offset === 0 && totalResults >= 0) console.log(`[정보] 페이지 내 총 결과 수 표시 (추정): ${totalResults}개`);
        else if (offset === 0) console.warn('[경고] 총 결과 수 요소를 찾지 못했습니다.');

        // 다음 요청에 필요한 hidden 값 업데이트
        const nextHiddenFormParams = {};
        // *** 다음 페이지 폼 선택자 확인 필요! ID가 다를 수 있음 ***
        $('#displaySearchCorpListByGenCondDispForm input[type="hidden"]').each((i, elem) => {
            const name = $(elem).attr('name');
            const value = $(elem).val();
            if (name) nextHiddenFormParams[name] = value || '';
        });
         // 다음 요청을 위한 CSRF/VS 토큰이 nextHiddenFormParams에 제대로 있는지 확인
         if (!nextHiddenFormParams['_csrf'] || !nextHiddenFormParams['_vs']) {
             console.warn(`[경고][오프셋 ${offset}] 다음 요청에 필요한 CSRF/VS 토큰을 응답 HTML에서 찾지 못했습니다. 현재 토큰을 재사용합니다.`);
             // 현재 토큰을 다음 파라미터에 유지
             nextHiddenFormParams['_csrf'] = csrfToken;
             nextHiddenFormParams['_vs'] = vsToken;
         } else {
             console.log(`[정보][오프셋 ${offset}] 다음 요청용 CSRF/VS 토큰 갱신됨.`);
         }


        console.log('[정보] 결과 파싱 시작...');
        const companiesOnPage = parseSearchResults_NewFormat(responseData);
        return { companies: companiesOnPage, total: totalResults, nextParams: nextHiddenFormParams };

    } else { /* 오류 처리 */ return null; }

  } catch (error) { /* 오류 처리 */ return null; }
}

// --- 파싱 함수 (parseSearchResults_NewFormat) ---
function parseSearchResults_NewFormat(html) {
    try {
      const $ = cheerio.load(html);
      const companies = [];
      const companyElements = $('.boxSearchresultEach.corp');
      console.log(`[파싱] '${companyElements.selector}' 선택자로 ${companyElements.length}개 항목 발견`);

      if (companyElements.length === 0) {
          if ($('.searchResultCaution, .caution').text().includes('該当する企業が見つかりませんでした')) console.log("[파싱] '해당 기업 없음' 메시지 발견.");
          else if (html.includes('認証の有効期限が切れています')) console.error('[파싱] HTML 내용에 인증 만료 메시지가 포함되어 있습니다.');
          else if (html.includes('Bad Request') || html.includes('不正なリクエスト')) console.error('[파싱] HTML 내용에 Bad Request 오류가 포함되어 있습니다.');
          else console.warn("[파싱] 회사 목록 요소를 찾지 못했습니다.");
          return [];
      }

      companyElements.each((index, element) => {
        const company = $(element);
        let name = '', link = '', description = '', corpId = '';

        const nameLinkElement = company.find('h3.withCheck a.js-add-examination-list-text');
        if (nameLinkElement.length > 0) {
            name = nameLinkElement.text().trim();
            link = nameLinkElement.attr('href') || '';
            if (link && !link.startsWith('http')) link = `https://job.mynavi.jp${link}`;
        } else {
             const altNameLink = company.find('.boxSearchresultEach_head h3 a');
             if(altNameLink.length > 0) {
                 name = altNameLink.text().trim();
                 link = altNameLink.attr('href') || '';
                 if (link && !link.startsWith('http')) link = `https://job.mynavi.jp${link}`;
             }
        }

        const descElement = company.find('p.catchTxt');
        if (descElement.length > 0) description = descElement.text().trim().replace(/\s+/g, ' ');

        const divIdAttr = company.attr('id');
        if (divIdAttr && divIdAttr.startsWith('div')) {
            corpId = divIdAttr.substring(3);
            if (!/^\d+$/.test(corpId)) corpId = '';
        }
        if (!corpId && link) {
            const linkMatch = link.match(/corp(\d+)/);
            if (linkMatch && linkMatch[1]) corpId = linkMatch[1];
        }
        if (!corpId) {
             const dataAttrId = company.find('.js-add-examination-list-button').data('examination-list-corp-id');
             if(dataAttrId) corpId = String(dataAttrId);
        }

        if (!name) console.warn(`[파싱 경고] 이름 추출 실패. index: ${index}`);
        if (!corpId) console.error(`[파싱 실패] ID 추출 실패. index: ${index}`);

        if (name && corpId) companies.push({ name, description, link: link || '', corpId });
      });

      console.log(`[파싱] 현재 페이지에서 ${companies.length}개 회사 정보 파싱 완료.`);
      return companies;
    } catch (error) {
      console.error('[치명적 오류] 파싱 함수 실행 중 오류 발생:', error.message);
      return [];
    }
}

// --- 상세 정보 크롤링 함수들 ---
// (이전 코드에서 getCompanyJobInfo, crawlSingleEmploymentPage 복사 붙여넣기)
// ...

// --- 메인 실행 함수 (페이지네이션 루프 + 숨겨진 값 전달) ---
async function main() {
    const keyword = process.argv[2] || 'IT';
    const limitCompanies = parseInt(process.argv[3]) || 5;
    const pageSize = 100;

    console.log(`\n=== 마이나비 크롤링 테스트 시작 (페이지네이션 + 토큰/숨김값 자동화) ===`);
    console.log(`키워드: "${keyword}"`);
    const filtersToApply = { wf: ["1830"] };
    console.log(`필터:`, filtersToApply);
    console.log(`==========================================================\n`);

    // 1. 초기 숨겨진 폼 파라미터 가져오기
    const initialFormParams = await getHiddenFormParams(`https://job.mynavi.jp/26/pc/corpinfo/searchCorpListByGenCond/index/?cond=FW:${encodeURIComponent(keyword || '')}`);
    if (!initialFormParams) {
        console.error('\n[종료] 초기 폼 파라미터 가져오기 실패.');
        return;
    }
    let currentHiddenParams = initialFormParams; // 다음 요청에 전달할 파라미터 객체

    let allCompanies = [];
    let offset = 0;
    let currentPage = 1;
    let totalReportedResults = -1;
    const maxPages = 10;

    while (currentPage <= maxPages) {
        console.log(`\n--- 페이지 ${currentPage} (오프셋 ${offset}) 요청 시작 ---`);

        if (!currentHiddenParams || !currentHiddenParams['_csrf'] || !currentHiddenParams['_vs']) { // 토큰 유효성 검사 강화
            console.error(`[오류] 페이지 ${currentPage} 요청에 필요한 CSRF/VS 토큰 없음. 루프 중단.`);
            // 토큰을 다시 가져오는 시도 (선택적)
            // currentHiddenParams = await getHiddenFormParams(...);
            // if (!currentHiddenParams) break;
            break; // 일단 중단
        }
        console.log(`[정보] 현재 사용할 토큰: CSRF=${currentHiddenParams['_csrf']?.substring(0,10)}..., VS=${currentHiddenParams['_vs']?.substring(0,10)}...`);

        // 2. 현재 페이지 검색 실행
        const result = await searchMynavi(keyword, filtersToApply, currentHiddenParams['_csrf'], currentHiddenParams['_vs'], offset, currentHiddenParams);

        if (result === null) {
            console.error(`[오류] 페이지 ${currentPage} 처리 실패. 루프 중단.`);
            break;
        }

        const companiesOnPage = result.companies;
        // *** 다음 요청을 위해 숨겨진 파라미터 업데이트 ***
        currentHiddenParams = result.nextParams;

        if (totalReportedResults < 0 && result.total >= 0) {
             totalReportedResults = result.total;
             console.log(`[정보] 서버에서 보고된 총 결과 수: ${totalReportedResults}개`);
        }

        if (companiesOnPage.length > 0) {
            allCompanies = allCompanies.concat(companiesOnPage);
            console.log(`[정보] 페이지 ${currentPage} 완료. ${companiesOnPage.length}개 추가됨 (현재 총 ${allCompanies.length}개)`);
        } else {
            console.log(`[정보] 페이지 ${currentPage}에서 회사 정보를 찾지 못했습니다.`);
            break; // 결과 없으면 종료
        }

        // 마지막 페이지 판단
        if (companiesOnPage.length < pageSize || (totalReportedResults > 0 && allCompanies.length >= totalReportedResults)) {
            console.log(`[정보] 마지막 페이지 도달 또는 모든 결과 수집 완료로 판단. 크롤링 종료.`);
            break;
        }

        // 다음 페이지 준비
        offset += companiesOnPage.length;
        currentPage++;
        const waitTime = 1.5 + Math.random() * 1.5;
        console.log(`[정보] 다음 페이지 요청 전 ${waitTime.toFixed(1)}초 대기...`);
        await delay(waitTime);

    } // End while loop

    if (currentPage > maxPages) console.warn(`[경고] 최대 페이지(${maxPages}) 제한 도달.`);

    console.log(`\n\n=== 최종 결과 요약 ===`);
    console.log(`총 ${allCompanies.length}개 회사 정보 수집 완료.`);
    if (totalReportedResults >= 0) console.log(`(페이지 내 보고된 총 결과 수: ${totalReportedResults}개)`);

    // 상세 정보 크롤링 부분은 일단 생략하고 목록만 저장
    const displayLimit = Math.min(limitCompanies, allCompanies.length);
    console.log(`\n찾아낸 회사 목록 (상위 ${displayLimit}개):`);
    allCompanies.slice(0, displayLimit).forEach((c, i) => console.log(`${i+1}. ${c.name} (ID: ${c.corpId})`));
    const outputFilename = `mynavi_jobs_${keyword.replace(/[^a-zA-Z0-9]/g, '_')}_all_filtered.json`;
    try {
        fs.writeFileSync(outputFilename, JSON.stringify(allCompanies, null, 2));
        console.log(`\n[성공] 전체 회사 목록 (${allCompanies.length}개)을 ${outputFilename} 파일로 저장했습니다.`);
    } catch (writeError) { console.error(`[오류] 최종 결과 파일 저장 실패: ${writeError.message}`); }
    console.log(`====================\n`);
}

// --- 메인 함수 실행 ---
main().catch(error => {
    console.error("[치명적 오류] 메인 함수 실행 중 예외 발생:", error);
});