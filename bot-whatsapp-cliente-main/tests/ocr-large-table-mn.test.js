const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { readRouteImageOcr, shutdownRouteOcrEngine, getCageLetterEvidence, findAllGaiolaCodesFromOcr } = require("../dist/bot/ocr");
const { selectPreferredNeighborhoodFromOcr, findManualRouteCandidatesFromOcr } = require("../dist/bot/ocrNeighborhoodSelection");
const { verifyAmbiguousCageLetters } = require("../dist/bot/ocrCageLetterVerification");
const word = (text, left, top, width = text.length * 9, height = 20, confidence = 94) => ({ text, left, top, width, height, confidence });
const reading = (words, source = "fixture") => ({ source: `tesseract-js:${source}`, text: words.map(w => w.text).join(" "), lines: words.map(w => ({ text: w.text, words: [w], ...w })) });
const header = () => [word("ROTA", 20, 10), word("AT", 140, 10), word("CLUSTER", 300, 10), word("BAIRRO", 580, 10), word("ID", 850, 10)];
const row = (code, at, district, top, codeConfidence = 94) => [word(code, 20, top, 45, 20, codeConfidence), word(at, 150, top), word("Campos", 300, top), word(district, 580, top), word("123456", 850, top)];
const preferred = [{ bairro: "Parque Vicente Gonçalves Dias" }, { bairro: "Parque Aurora" }];

test("mantém Parque na mesma linha quando o AT tem caixa baixa e o nome tem descendentes", () => {
  const words = [word("ROTA",31,32), word("AT",241,32), word("CLUSTER",537,32), word("BAIRRO",1056,32), word("ID",1497,32),
    word("M-22",35,286,69,22,0), word("AT20261127DMAWE",251,287,242,19), word("Campos",537,290,106,28), word("Parque",676,290,89,28), word("Prazeres",777,290,108,22),
    word("Parque",1056,290,90,29), word("Vicente",1155,288,98,24), word("Gonçalves",1264,288,135,31), word("Dias",1409,288,55,24)];
  const first = reading(words), ocr = { ...first, variants: [first, structuredClone(first)] };
  const manual = findManualRouteCandidatesFromOcr(ocr).find(item => item.code === "M-22");
  assert.equal(manual.bairro, "Parque Vicente Gonçalves Dias");
  assert.equal(selectPreferredNeighborhoodFromOcr(ocr, preferred).detection.code, "M-22");
});

test("foto grande recomprimida conserva M-22 e não confunde com N-22", {skip:process.env.RUN_REAL_OCR_TESTS!=="1",timeout:120000}, async () => {
  const sharp=require("sharp"), dir=fs.mkdtempSync(path.join(os.tmpdir(),"ocr-large-recompressed-")), image=path.join(dir,"large.jpg");
  try {
    await sharp(path.join(__dirname,"fixtures","nov27-route-table.png")).resize({width:1870}).jpeg({quality:80}).toFile(image);
    const ocr=await readRouteImageOcr(image,{maxReadings:5,fastFirst:true,preferCageCrop:false});
    const result=selectPreferredNeighborhoodFromOcr(ocr,preferred,0,0,"preference");
    assert.equal(result.status,"selected",JSON.stringify({reason:result.reason,text:ocr.text}));
    assert.equal(result.detection.code,"M-22");
    assert.ok(!findAllGaiolaCodesFromOcr(ocr).some(item=>item.code==="N-22"));
  } finally { await shutdownRouteOcrEngine(); fs.rmSync(dir,{recursive:true,force:true}); }
});

test("tabela ROTA/AT/CLUSTER/BAIRRO/ID sem quantidades permite linha completa e não incorpora ID", () => {
  const ocr = reading([...header(), ...row("L-27","AT20261127DMARL","Donana",100)]);
  const result = selectPreferredNeighborhoodFromOcr(ocr, [{ bairro: "Donana" }]);
  assert.equal(result.status, "selected"); assert.equal(result.detection.code, "L-27");
  assert.equal(result.detection.paradas, undefined); assert.equal(result.detection.pacotes, undefined);
  assert.equal(findManualRouteCandidatesFromOcr(ocr)[0].bairro, "Donana");
});

test("caixa de outra linha não completa um bairro perdido", () => {
  const ocr = reading([...header(), ...row("M-22","AT20261127DMAWE","Vicente Gonçalves Dias",100), word("Parque",580,135,70,20)]);
  assert.notEqual(selectPreferredNeighborhoodFromOcr(ocr, [preferred[0]]).status, "selected");
});

test("k-15 e kK-31 são normalizados somente na célula de gaiola antes do AT", () => {
  for (const [code, expected] of [["k-15","K-15"], ["kK-31","K-31"]]) {
    const result = selectPreferredNeighborhoodFromOcr(reading([...header(), ...row(code,"AT20261127DM9DJ","Farol",100)]), [{ bairro: "Farol" }]);
    assert.equal(result.status, "selected"); assert.equal(result.detection.code, expected);
  }
});

test("M/N com confiança baixa exige confirmação adicional em vez de aceitar só o cabeçalho", () => {
  const result = selectPreferredNeighborhoodFromOcr(reading([...header(), ...row("M-22","AT20261127DMAWE","Parque Vicente Gonçalves Dias",100,0)]), preferred);
  assert.notEqual(result.status, "selected");
});

test("L-2u4 recupera L-24 com leituras concordantes e não vira envio inferido de leitura única", () => {
  const first=reading([...header(),...row("L-2u4","AT20261127DMAVJ","Goitacazes",100)]);
  assert.notEqual(selectPreferredNeighborhoodFromOcr(first,[{bairro:"Goitacazes"}]).status,"selected");
  const result=selectPreferredNeighborhoodFromOcr({...first,variants:[first,structuredClone(first)]},[{bairro:"Goitacazes"}]);
  assert.equal(result.status,"selected"); assert.equal(result.detection.code,"L-24");
});

test("confirmação ampliada distingue M e N e recupera 1-22 só na linha do mesmo AT", async t => {
  const sharp = require("sharp"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-mn-contract-")), image = path.join(dir,"table.png");
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  await sharp({create:{width:1000,height:220,channels:3,background:"white"}}).png().toFile(image);
  const first = reading([...header(), ...row("M-22","AT20261127DMAWE","Parque Vicente Gonçalves Dias",100,0), ...row("N-22","AT20261127DMXYZ","Parque Aurora",140)],"fixture");
  const other = reading([...header(), ...row("1-22","AT20261127DMAWE","Parque Vicente Gonçalves Dias",100,1), ...row("N-22","AT20261127DMXYZ","Parque Aurora",140)],"other");
  let checks = 0;
  const result = await verifyAmbiguousCageLetters([first,other],[{path:image,label:"fixture"}],async()=> {
    checks++;
    return {text:"M-22\nN-22",source:"focused",lines:[{text:"M-22",top:50,left:10,width:100,height:80,confidence:90,words:[]},{text:"N-22",top:217,left:10,width:100,height:80,confidence:90,words:[]}]};
  });
  assert.equal(checks,2); assert.equal(result.verified,2);
  const recovered = other.lines.flatMap(l=>l.words).find(w=>w.text==="1-22");
  assert.equal(recovered.verifiedCageCode,"M-22");
  const genuineN = other.lines.flatMap(l=>l.words).find(w=>w.text==="N-22");
  assert.equal(genuineN.verifiedCageCode,"N-22");
  const selection=selectPreferredNeighborhoodFromOcr({...first,variants:[first,other]},preferred,0,0,"preference");
  assert.equal(selection.status,"selected"); assert.equal(selection.detection.code,"M-22");
});

test("leituras ampliadas discordantes não autorizam M/N nem trocam o número", async t => {
  const sharp = require("sharp"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-mn-conflict-")), image=path.join(dir,"table.png");
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  await sharp({create:{width:1000,height:180,channels:3,background:"white"}}).png().toFile(image);
  for(const alternative of ["N-22","M-23"]) {
    const first=reading([...header(),...row("M-22","AT20261127DMAWE","Parque Vicente Gonçalves Dias",100,0)]);
    let call=0;
    const result=await verifyAmbiguousCageLetters([first],[{path:image,label:"fixture"}],async()=>({text:"",source:"focused",lines:[{text:call++?alternative:"M-22",top:50,left:10,width:100,height:80,confidence:90,words:[]}]}));
    assert.equal(result.conflicts,1); assert.equal(result.verified,0);
    assert.notEqual(selectPreferredNeighborhoodFromOcr(first,preferred).status,"selected");
    assert.equal(getCageLetterEvidence(first.lines.flatMap(l=>l.words),"M-22").conflict,true);
  }
});

test("a primeira leitura 1-22 também é conferida quando outra identifica M-22 pelo mesmo AT", async t => {
  const sharp=require("sharp"),dir=fs.mkdtempSync(path.join(os.tmpdir(),"ocr-mn-order-")),image=path.join(dir,"table.png");
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  await sharp({create:{width:1000,height:220,channels:3,background:"white"}}).png().toFile(image);
  const first=reading([...header(),...row("N-27","AT20261127DM10S","Parque Aurora",100,1),...row("1-22","AT20261127DMAWE","Parque Vicente Gonçalves Dias",140,32)]);
  const other=reading([...header(),...row("N-27","AT20261127DM10S","Parque Aurora",100,1),...row("M-22","AT20261127DMAWE","Parque Vicente Gonçalves Dias",140,41)],"other");
  await verifyAmbiguousCageLetters([first,other],[{path:image,label:"fixture"}],async()=>({text:"",source:"focused",lines:[{text:"N-27",top:50,left:10,width:100,height:80,confidence:90,words:[]},{text:"M-22",top:217,left:10,width:100,height:80,confidence:90,words:[]}]}));
  const selection=selectPreferredNeighborhoodFromOcr({...first,variants:[first,other]},preferred,0,0,"preference");
  assert.equal(selection.status,"selected"); assert.equal(selection.detection.code,"M-22");
});

test("leitura não ambígua evita OCR ampliado e não carrega imagem adicional", async () => {
  const first=reading([...header(),...row("M-22","AT20261127DMAWE","Parque Vicente Gonçalves Dias",100,94)]);
  let calls=0;
  const result=await verifyAmbiguousCageLetters([first],[{path:"does-not-exist.png",label:"fixture"}],async()=>{calls++;throw new Error("unexpected");});
  assert.equal(calls,0); assert.equal(result.verified,0);
});

test("seta de filtro ao lado de pacotes não vira gaiola manual numa lista de motoristas", () => {
  const ocr=reading([word("MOTORISTA",20,10),word("MODAL",240,10),word("PACOTES",600,10),word("Rodrigo",20,100),word("PASSEIO",240,100),word("V",550,100),word("39",600,100)]);
  assert.deepEqual(findManualRouteCandidatesFromOcr(ocr),[]);
});

test("foto real de 27/11 libera M-22 automaticamente e preserva N-27, N-23 e M-8", {skip:process.env.RUN_REAL_OCR_TESTS!=="1",timeout:120000}, async t => {
  try {
    const start=performance.now();
    const ocr=await readRouteImageOcr(path.join(__dirname,"fixtures","nov27-route-table.png"),{maxReadings:1,fastFirst:true,preferCageCrop:false});
    const result=selectPreferredNeighborhoodFromOcr(ocr,preferred,0,0,"preference");
    assert.equal(result.status,"selected",JSON.stringify({reason:result.reason,text:ocr.text}));
    assert.equal(result.detection.code,"M-22"); assert.equal(result.detection.bairro,"Parque Vicente Gonçalves Dias");
    const codes=new Set(findAllGaiolaCodesFromOcr(ocr).map(item=>item.code));
    for(const code of ["N-27","N-23","M-22","M-8"]) assert.ok(codes.has(code),`${code} missing: ${[...codes]}`);
    assert.equal(codes.has("N-22"),false); assert.equal(codes.has("N-8"),false);
    const centro=selectPreferredNeighborhoodFromOcr({...ocr,variants:[ocr.variants[0],structuredClone(ocr.variants[0])]},[{bairro:"Centro",regiao:"Campos - Tamandaré"}]);
    assert.equal(centro.detection.code,"L-6");
    // Exercise unattended analysis -> confirmed waiting -> group opening ->
    // transport, without any manual selection or real WhatsApp connection.
    const { BotService }=require("../dist/bot/connection"), isolated=require("../dist/bot/ocrIsolated");
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"unattended-nov27-")), file=name=>path.join(dir,`${name}.json`);
    const bot=new BotService({clientEmail:"fixture@test.com",configPath:file("config"),routeStorePath:file("routes"),dispatchQueuePath:file("queue"),telemetryPath:file("telemetry"),ocrAnalysisHistoryPath:file("ocr"),logStorePath:file("logs")});
    const original=isolated.readRouteImageOcrWithoutBlockingSocket; const calls=[], sent=[];
    try {
      bot.configStore.save({grupoAlvoJid:"fixture@g.us",grupoAlvoNome:"Fixture",nomeEnvio:"Cliente",targetDispatchMode:"ocr",rotasMonitoradasDetalhadas:preferred.slice(0,1)});
      bot.status="connected"; bot.monitoringEnabled=true; bot.preparedTargetJid="fixture@g.us";bot.preparedTargetDispatchMode="ocr";bot.groupState="closed";bot.latestRouteImageSequence=1;
      bot.emitSnapshot=()=>undefined;bot.keepIdlePreparationAlive=()=>undefined;
      bot.downloadRouteImage=async()=>fs.readFileSync(path.join(__dirname,"fixtures","nov27-route-table.png"));
      bot.createRouteImagePreview=async()=>undefined;
      bot.rebuildPreparedRelayMessages=(_jid,messages)=>{bot.preparedRelayMessages=messages.map((text,i)=>({key:{id:`fixture-${i}`},message:{conversation:text}}));};
      bot.sock={relayMessage:async(_jid,message)=>{sent.push(message.conversation);}};
      isolated.readRouteImageOcrWithoutBlockingSocket=async(_file,options)=>{calls.push(options.maxReadings);return structuredClone(ocr);};
      await bot.processRouteImageBatch([{messageId:"fixture-image",groupJid:"fixture@g.us",msg:{}}],1);
      assert.deepEqual(calls,[1]); assert.deepEqual(sent,[]);
      assert.equal(bot.ocrRouteSelection.status,"confirmed"); assert.equal(bot.ocrRouteSelection.dispatchState,"waiting");
      assert.deepEqual(bot.pendingOcrMessages,["Cliente M-22"]);
      assert.ok(bot.ocrRouteSelection.options.every(option=>option.passedFilters&&!option.manualOnly));
      bot.handleGroupsUpdate([{id:"fixture@g.us",announce:false}],bot.activeConnectionId);
      await bot.activeSendCycle;await new Promise(resolve=>setImmediate(resolve));
      assert.deepEqual(sent,["Cliente M-22"]);assert.equal(bot.getRoutes()[0].confirmedCount,1);
    } finally {
      isolated.readRouteImageOcrWithoutBlockingSocket=original;
      bot.clearWarmKeepAliveTimer();await bot.logger.flush();
      for(const store of [bot.routeStore,bot.dispatchQueueStore,bot.telemetryStore,bot.ocrAnalysisHistoryStore])await store.flush();
      fs.rmSync(dir,{recursive:true,force:true});
    }
    t.diagnostic(`Real image: ${Math.round(performance.now()-start)}ms; ${ocr.source}`);
  } finally {await shutdownRouteOcrEngine();}
});
