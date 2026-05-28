### 题目描述

定义一个函数 `f(s)`，统计 `s`  中**（按字典序比较）最小字母的出现频次** ，其中 `s` 是一个非空字符串。

例如，若 `s = "dcce"`，那么 `f(s) = 2`，因为字典序最小字母是 `"c"`，它出现了 2 次。

现在，给你两个字符串数组待查表 `queries` 和词汇表 `words` 。对于每次查询 `queries[i]` ，需统计 `words` 中满足 `f(queries[i])` < `f(W)` 的** 词的数目** ，`W` 表示词汇表 `words` 中的每个词。

请你返回一个整数数组 `answer` 作为答案，其中每个 `answer[i]` 是第 `i` 次查询的结果。

 

**示例 1：**

```
**输入：**queries = ["cbd"], words = ["zaaaz"]
**输出：**[1]
**解释：**查询 f("cbd") = 1，而 f("zaaaz") = 3 所以 f("cbd") < f("zaaaz")。
```

**示例 2：**

```
**输入：**queries = ["bbb","cc"], words = ["a","aa","aaa","aaaa"]
**输出：**[1,2]
**解释：**第一个查询 f("bbb")  f("cc")。
```

 

**提示：**

	- `1 <= queries.length <= 2000`

	- `1 <= words.length <= 2000`

	- `1 <= queries[i].length, words[i].length <= 10`

	- `queries[i][j]`、`words[i][j]` 都由小写英文字母组成

## 解法

```java
class Solution {
    public int[] numSmallerByFrequency(String[] queries, String[] words) {
        int n=queries.length;
        int[] ans = new int[n];
        int m=words.length;
        int[] wordsNums=new int[m];
        for(int i=0;i<m;i++){
            wordsNums[i]=f(words[i]);
        }
        Arrays.sort(wordsNums);
        for(int i=0;i<n;i++){
           int r=m;
           int l=-1;
           while(r>l+1){
            int middle=l+(r-l)/2;
            if(wordsNums[middle]>f(queries[i])){
                r=middle;
            }else{
                l=middle;
            }
           }
           ans[i]=m-r;
        }
        return ans;
    }

    public int f (String s){
         int[] cnt = new int[26]; // 创建一个长度为 26 的数组，用于存储每个字符出现的次数

        // 遍历单词的每个字符，更新字符出现次数
        for (char c : s.toCharArray()) {
            ++cnt[c - 'a']; // 累加对应字符的出现次数
        }

                // 查找最小字符出现的次数，并返回该次数
        for (int i = 0; i < 26; i++) {
            if (cnt[i] != 0) return cnt[i]; // 返回最小字符出现的次数
        }
        return -1;
    }
}
```
