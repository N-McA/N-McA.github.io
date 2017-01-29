

var peer = false
let intervalId = setInterval(() => {
  if (window.peers[0]) {
    peer = window.peers[0]
    clearInterval(intervalId)
  }
}, 500)

// Search Page Variables
let searchButton = document.getElementById('search-button')
let searchBar = document.getElementById('search-bar')

let searchPageButton = document.getElementById('search-page-button'); 
let searchPage = document.getElementById('search-page');

let resultsTable = document.getElementById('results-table')
let iframe = document.getElementById('iframe')
// End Search Page

// Upload Page
let uploadPageButton = document.getElementById('upload-page-button'); 
let uploadPage = document.getElementById('upload-page');
let uploadHTMLField = document.getElementById('upload-html');
let uploadKeywords = document.getElementById('upload-keywords');
let uploadComment = document.getElementById('upload-comment');
let uploadButton = document.getElementById('upload-button');
uploadPage.style.display = 'none'
// End Upload Page


searchPageButton.onclick = () => {
	searchPage.style.display = 'block' 
	iframe.style.display = 'block' 
  uploadPage.style.display = 'none'
};

uploadPageButton.onclick = () => {
  uploadPage.style.display = 'block'
	searchPage.style.display = 'none'
	iframe.style.display = 'none' 
  
};

// Search Page

function showResult([keywordString, comment, html]) {
  try {
    let row = document.createElement("tr")
    for (let d of [comment, keywordString]) {
      let txt = document.createTextNode(d)
      let cell = document.createElement("td")
      cell.appendChild(txt)
      row.appendChild(cell)
    }
    let cell = document.createElement("td")
    let link = document.createElement("a")
    link.href = "#"
    link.text = "display"
    link.onclick = () => {
      populateIframe(html)
    }
    cell.appendChild(link)
    row.appendChild(cell)
    resultsTable.appendChild(row)
  } catch (e) {
    console.log(e)
  }
}

// [{keywords:["foo"], value:"..."}]
//

function commentSanityCheck(comment) {
  if (comment.length > 140) throw "Long comment..."
}

function processResource(res) {
  try {
    let keywordString = res.keywords.join(" ")
    let v = JSON.parse(res.value)
    let html = v.html
    let comment = v.comment
    commentSanityCheck(comment)
    return [keywordString, comment, html]
  } catch (e) {
    console.log(e)
    return ["", "", ""]
  }
}

function clearResults() {
  while (resultsTable.firstChild) {
    resultsTable.removeChild(resultsTable.firstChild)
  }
}

// peer = {}
// peer.search = (foo) => Promise.resolve([[
//   {
//     keywords:["foo", "bar"],
//     value:JSON.stringify({html:"<p>Test<p>", comment:"hectic"})
//   }
// ], "rpcid"])

function populateIframe(html) {
  let newIFrame = document.createElement("iframe")
  document.getElementById("iframe-row").replaceChild(newIFrame, iframe)
  let doc = newIFrame.contentDocument
  doc.open()
  doc.write(html)
  doc.close()
  iframe = newIFrame
}

let lastSearch = searchBar.value
searchButton.onclick = () => {
  let q = searchBar.value
  if (q === "") return
  if (q === lastSearch) return
  clearResults()
  lastSearch = q
  console.log("Searching for " + q)
  peer.search(q).then(([results, rpcid]) => {
    console.log("results!!!!")
    console.log(results)
    results.map(processResource).map(showResult)
  })
}

// End Search Page

function sanityCheckHTML(html) {
  if (html.length > 2000) throw "Too Long"
}

function sanityCheckComment(comment) {
  if (comment.length > 140) throw "Too Long"
}

function sanityCheckKeywords(keywordString) {
  if (keywordString.length > 1000) throw "Too Long"
  if (keywordString.split(" ").length > 10) throw "Too many keywords"
}

// Upload Page
let oldhtml = ""
uploadButton.onclick = () => {
  let html = uploadHTMLField.value
  if (html === oldhtml) return
  oldhtml = html
  let keywordString = uploadKeywords.value
  if (keywordString === "") return
  let comment = uploadComment.value
  sanityCheckHTML(html)
  sanityCheckKeywords(keywordString)
  sanityCheckComment(keywordString)
  let value = JSON.stringify({
    html: html,
    comment: comment
  })
  peer.dhtStringStore(value, keywordString)
}


// End Upload Pages
