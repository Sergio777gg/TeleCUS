module.exports={
  uiPort:Number(process.env.NODE_RED_PORT||1880),uiHost:process.env.NODE_RED_HOST||'127.0.0.1',
  httpAdminRoot:process.env.NODE_RED_DISABLE_EDITOR==='true'?false:'/editor',flowFile:'flows.json',credentialSecret:process.env.TELECUS_INTERNAL_TOKEN,
  adminAuth:process.env.NODE_RED_DISABLE_EDITOR==='true'?undefined:{type:'credentials',users:[{username:'admin',password:process.env.NODE_RED_PASSWORD_HASH,permissions:'*'}]},
  functionExternalModules:false,externalModules:{autoInstall:false,palette:{allowInstall:false}},
  logging:{console:{level:'warn',metrics:false,audit:false}},
  editorTheme:{projects:{enabled:false}},
};
